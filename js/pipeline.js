// The acquire -> track -> verify loop, with no DOM in sight so it can be
// driven by synthetic frames in the tests.
//
// Acquisition is expensive and needs a moment of stillness; tracking is cheap
// and tolerates motion but needs a starting outline. So the pipeline stays in
// tracking for as long as the outline keeps passing its sanity checks, and
// falls back to acquisition only after several consecutive bad frames - a
// hand passing in front of the screen or one dark cut should not cost the
// lock.
//
// Two channels come in per frame. Light says where things are bright; change -
// the difference against the previous frame - says where a film is playing.
// In a dark cinema the two agree and light alone would do. In a lit room they
// do not: a lamp-lit wall can outshine the picture, and every brightness-based
// decision in here betrayed exactly that scene until change was made the
// arbiter. A wall is bright but still; a screen is bright and moving.

import { Acquirer, insideQuad } from './detect.js';
import { makeGray } from './image.js';
import { dist, inwardNormal, isConvex, quadArea, quadsClose } from './geom.js';
import { QuadSmoother } from './smooth.js';
import { defaultRadius, trackQuad } from './track.js';
import { estimateAspect, focalFromFov } from './aspect.js';

export const SEARCHING = 'searching';
export const LOCKED = 'locked';

const clampAbs = (v, limit) => Math.max(-limit, Math.min(limit, v));

// Tiny 3x3 linear solve via Cramer's rule; null when degenerate.
function solve3(A, b) {
	const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
		- A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
		+ A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
	if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
	const sub = (col) => {
		const M = A.map((row) => row.slice());
		for (let r = 0; r < 3; r++) M[r][col] = b[r];
		return M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
			- M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
			+ M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
	};
	return [sub(0) / det, sub(1) / det, sub(2) / det];
}

export class ScreenPipeline {
	constructor(w, h, opts = {}) {
		this.w = w;
		this.h = h;
		this.acquirer = new Acquirer(w, h, opts.acquire);
		// The change channel keeps its own accumulator: a faster decay, because
		// it answers "is a film playing there NOW", and a lower fill demand,
		// because a film does not touch every pixel in every second.
		// minStep is far below the light channel's: the background of a change
		// map is near-zero, so even a quiet film clears its surroundings by
		// twelve where a screen clears a lit room by a hundred.
		this.changeAcquirer = new Acquirer(w, h, {
			decay: 0.92, minFill: 0.5, minStep: 12, threshold: 12, ...opts.changeAcquire,
		});
		// Acquisition from change runs on a coarse, spread-out copy of that
		// map. A film does not change everywhere at once - measured off a real
		// recording of a dance performance on a wall-mounted television, the
		// pixels above threshold at any moment were 1.5% of the view and
		// filled less than half of their own outline, so the blob never looked
		// like a screen and the app searched for three seconds at something
		// plainly playing in front of it. Block-max to a quarter scale and
		// dilate, and the scattered activity becomes the region it belongs to,
		// while the thin residual lines that survive motion compensation stay
		// thin and fall away.
		// How many still frames make the gyroscope-gated map authoritative.
		this.stillEnough = opts.stillEnough ?? 8;
		this.coarseStep = opts.coarseStep ?? 4;
		// Two neighbours, not three: a film's activity at any moment is
		// patchy, and demanding company on three sides erased a real dance
		// performance entirely while keeping a radiator's fins.
		this.coarseErode = opts.coarseErode ?? 2;
		this.coarseW = Math.ceil(w / this.coarseStep);
		this.coarseH = Math.ceil(h / this.coarseStep);
		this.coarse = new Float32Array(this.coarseW * this.coarseH);
		this.coarseSwap = new Float32Array(this.coarseW * this.coarseH);
		// The threshold separates a film from a room's furniture by magnitude,
		// which is what actually distinguishes them: measured off the real
		// recording, cells over the television read 30-80 and the fins of a
		// radiator - regular texture, endlessly re-shifted by a hand that
		// cannot hold still - read 10-30.
		this.coarseAcquirer = new Acquirer(this.coarseW, this.coarseH, {
			minFill: 0.45, minStep: 8, threshold: 28, minHullFit: 0.8, ...opts.coarseAcquire,
		});
		// What counts as change rises with the local gradient. A room has
		// depth, so no single shift compensates a wall and a near table edge
		// at once, and whatever sub-pixel error is left shows up at every hard
		// edge as change of roughly gradient times error - a 160-level edge
		// mis-aligned by a fifth of a pixel writes 32 into the map, far above
		// any flat floor. Scaling the floor by the gradient asks the right
		// question instead: not "did this pixel change" but "did it change by
		// more than sliding the picture slightly would explain". A film
		// changes because its content changed, and sails past; the outline of
		// a keyboard does not.
		this.edgeAllowance = opts.edgeAllowance ?? 0.55;
		// Even with the camera perfectly still, resampling the reference at a
		// fractional offset softens every hard edge, and the difference that
		// leaves behind is a fixed fraction of the local gradient. This is the
		// floor under the motion-scaled allowance above.
		this.edgeFloorAllowance = opts.edgeFloorAllowance ?? 0.19;
		// Where a film has EVER played, decaying over minutes rather than
		// frames. This is what lets a bright still blob be judged: a screen
		// paused mid-film still sits where the change used to be; a wall does
		// not. Values go in with a noise floor subtracted, so sensor grain
		// never accumulates into fake evidence.
		this.longChange = new Float32Array(w * h);
		// Half-life around eight seconds: long enough that a film's region
		// survives its quiet stretches (the film re-stamps it constantly),
		// short enough that the trail of a person walking across the frame -
		// which is real change, in real places, none of them a screen - fades
		// before it distorts decisions for minutes.
		this.longDecay = opts.longDecay ?? 0.997;
		this.changeFloor = opts.changeFloor ?? 6;
		// A film counts as "seen" when at least this fraction of the view has
		// changed beyond the noise floor at some point. A fraction, not a mean:
		// a tablet across a room is a few percent of the frame, and no film on
		// it could ever lift a whole-frame average.
		this.minFilmFraction = opts.minFilmFraction ?? 0.02;
		this.minFilmContainment = opts.minFilmContainment ?? 0.6;
		this.smoother = new QuadSmoother({ snapDistance: 0.25 * Math.hypot(w, h), ...opts.smooth });
		this.trackOpts = { radius: defaultRadius({ w, h }), ...opts.track };
		this.stableFrames = opts.stableFrames ?? 3;
		this.maxMisses = opts.maxMisses ?? 6;
		// Frames with no visible edge at all. Longer than maxMisses: this is the
		// normal state when someone zooms right in, and dropping back to a raw
		// camera view under their fingers would be worse than coasting.
		this.maxBlindFrames = opts.maxBlindFrames ?? 60;
		this.minCoverage = opts.minCoverage ?? 0.02;
		this.minInteriorLuma = opts.minInteriorLuma ?? 45;
		this.insideFactor = opts.insideFactor ?? 0.6;
		this.edgeJump = opts.edgeJump ?? Math.max(4, 0.028 * Math.max(w, h));
		this.settleFrames = opts.settleFrames ?? 3;
		this.seekReach = opts.seekReach ?? 2.5;
		this.seekFrames = opts.seekFrames ?? 15;
		// Cinema is 2.4:1 at its widest, a phone on its side 0.56:1.
		this.minSeedRatio = opts.minSeedRatio ?? 0.4;
		this.maxSeedRatio = opts.maxSeedRatio ?? 4;
		this.minEdgeFrac = opts.minEdgeFrac ?? 0.06;
		// Slow, and gated against sudden changes: the first estimate at lock is
		// taken as-is, and after that a real screen keeps the shape it had.
		this.aspectSmoothing = opts.aspectSmoothing ?? 0.04;
		this.aspectJump = opts.aspectJump ?? Math.log(1.25);
		this.outlierWeight = opts.outlierWeight ?? 0.08;
		// A second of solid disagreement and the stored value gives way.
		this.aspectDoubtLimit = opts.aspectDoubtLimit ?? 30;
		this.lead = opts.lead ?? 1;
		this.coastDecay = opts.coastDecay ?? 0.75;
		this.strayLimit = opts.strayLimit ?? 0.15;
		this.strayBrightness = opts.strayBrightness ?? 0.5;
		this.strayFrames = opts.strayFrames ?? 6;
		this.strayChange = opts.strayChange ?? 18;
		// The stray check runs whenever the camera is merely hand-held, not
		// panning: motion compensation keeps the change map clean under
		// ordinary movement, so only genuinely fast motion - where the
		// compensation residuals at hard edges rival a playing picture - has
		// to silence it. Theft during a real pan is caught when the pan slows.
		this.velocityGate = opts.velocityGate ?? 2.5;
		this.sanityEvery = opts.sanityEvery ?? 20;
		this.sanityGrowth = opts.sanityGrowth ?? 1.35;
		this.assumedFocal = opts.focal ?? focalFromFov(w, opts.fov ?? 65);
		this.reset();
	}

	reset() {
		this.state = SEARCHING;
		this.quad = null;
		this.confidence = 0;
		this.aspect = null;
		this.misses = 0;
		this.blind = 0;
		this.edges = 0;
		this.candidate = null;
		this.candidateHits = 0;
		this.candidateMisses = 0;
		this.vetoed = null;
		this.vetoedHits = 0;
		this.measured = null;
		this.velocity = null;
		this.coast = 1;
		this.stray = 0;
		this.settled = 0;
		this.interiorDoubt = 0;
		this.seeking = 0;
		this.stillActivity = null;
		this.stillFrames = 0;
		this.sensor = null;
		this.aspectMethod = null;
		this.aspectDoubt = 0;
		this.slips = 0;
		this.frame = 0;
		this.searchFrames = 0;
		this.source = null;
		this.changeFrame = null;
		this.longChange.fill(0);
		this.acquirer.reset();
		this.changeAcquirer.reset();
		this.smoother.reset();
	}

	// Where the outline will be next frame if the camera carries on doing what
	// it just did, and the transform that says so. The tracker searches around
	// this, not around the smoothed outline: smoothing lags behind real motion,
	// and an outline that lags ends up inside the picture, where it happily
	// locks onto a moving shot instead of the edge of the screen.
	//
	// `coast` fades the extrapolation out over a second or so whenever there is
	// nothing to confirm it, so a lost outline drifts to a halt instead of
	// sailing across the room at whatever speed it was last seen moving.
	predict() {
		if (!this.measured) return { start: this.quad, applied: null };
		if (!this.velocity) return { start: this.measured, applied: null };
		const lead = this.lead * this.coast;
		return {
			start: this.measured.map((p, i) => [p[0] + this.velocity[i][0] * lead, p[1] + this.velocity[i][1] * lead]),
			applied: null,
		};
	}

	// Hand the pipeline an outline from outside - the user dragging the corner
	// handles - and go straight to tracking.
	seed(quad) {
		if (!quad || quad.length !== 4 || !isConvex(quad)) return false;
		this.measured = quad.map((p) => [p[0], p[1]]);
		this.velocity = null;
		this.coast = 1;
		this.settled = 0;
		// Hand-placed corners are a seed too, and a rougher one.
		this.seeking = this.seekFrames;
		this.stray = 0;
		this.blind = 0;
		this.searchFrames = 0;
		this.candidate = null;
		this.candidateHits = 0;
		this.candidateMisses = 0;
		this.source = 'seed';
		this.smoother.reset(quad);
		this.quad = this.smoother.quad;
		this.state = LOCKED;
		this.misses = 0;
		this.confidence = 0.5;
		this.updateAspect(this.quad, true);
		return true;
	}

	// How much of the view the outline covers. Corner positions are the wrong
	// thing to test once zoom is in play - a screen filling the view has all
	// four corners outside it - but "is the screen actually in front of the
	// camera" stays meaningful however far outside the corners are.
	coverage(quad) {
		const cols = 21, rows = 16;
		let inside = 0;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const x = ((c + 0.5) / cols) * this.w;
				const y = ((r + 0.5) / rows) * this.h;
				if (insideQuad(quad, x, y)) inside++;
			}
		}
		return inside / (cols * rows);
	}

	plausible(quad) {
		if (!quad || !isConvex(quad)) return false;
		for (const [x, y] of quad) {
			if (!isFinite(x) || !isFinite(y)) return false;
			// Somewhere past this the outline has run away rather than zoomed.
			if (Math.abs(x) > 6 * this.w || Math.abs(y) > 6 * this.h) return false;
		}
		const minEdge = this.minEdgeFrac * Math.min(this.w, this.h);
		for (let i = 0; i < 4; i++) {
			if (dist(quad[i], quad[(i + 1) % 4]) < minEdge) return false;
		}
		return this.coverage(quad) >= this.minCoverage;
	}

	// Picture that the outline has left out, as a fraction of the area it
	// contains.
	//
	// Individual edge checks can only ask "did this edge move oddly", and an
	// obstruction that creeps along at a few pixels a frame never looks odd on
	// any single frame - it just quietly takes the outline with it. This asks
	// the question that stays answerable however slow the theft is: is there
	// still screen out there that we have stopped calling screen?
	//
	// "Screen out there" demands both bright AND recently changing. Brightness
	// alone was a disaster in a lit room - the wall outside the outline is
	// bright everywhere, so a perfectly good hand-placed outline was executed
	// within three frames of being seeded. The wall does not play a film.
	strayLight(gray, quad) {
		const cols = 21, rows = 16;
		// Prefer evidence gathered while the phone was still, once there is
		// enough of it to be worth preferring.
		const peak = this.stillFrames >= this.stillEnough ? this.stillActivity.peak : this.changeAcquirer.peak;
		// A guard band around the outline: motion-compensation residuals ring
		// the screen's own high-contrast border a few pixels OUTSIDE a
		// perfectly placed outline, and they read as bright playing picture.
		// Executing a correct lock over its own edge glow was this check's
		// favourite pastime.
		const cx = quad.reduce((a, p) => a + p[0], 0) / 4;
		const cy = quad.reduce((a, p) => a + p[1], 0) / 4;
		const band = quad.map(([x, y]) => {
			const dx = x - cx, dy = y - cy;
			const len = Math.hypot(dx, dy) || 1;
			return [x + (dx / len) * 10, y + (dy / len) * 10];
		});
		let inSum = 0, inCount = 0;
		const raw = new Uint8Array(cols * rows);
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const x = Math.round(((c + 0.5) / cols) * this.w);
				const y = Math.round(((r + 0.5) / rows) * this.h);
				const i = y * this.w + x;
				if (insideQuad(quad, x, y)) { inSum += gray.data[i]; inCount++; }
				else if (!insideQuad(band, x, y)) raw[r * cols + c] = 1;
			}
		}
		if (inCount < 3) return 0;
		const lit = (inSum / inCount) * this.strayBrightness;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				if (!raw[r * cols + c]) continue;
				const x = Math.round(((c + 0.5) / cols) * this.w);
				const y = Math.round(((r + 0.5) / rows) * this.h);
				const i = y * this.w + x;
				raw[r * cols + c] = gray.data[i] >= lit && peak[i] >= this.strayChange ? 2 : 1;
			}
		}
		// Erosion: a stray point counts only in company. Exposed screen is a
		// coherent two-dimensional region; ghost residuals at a door handle or
		// a picture frame are isolated points and thin lines, and they were
		// out-voting reality one grid cell at a time.
		let strays = 0;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				if (raw[r * cols + c] !== 2) continue;
				let neighbours = 0;
				if (r > 0 && raw[(r - 1) * cols + c] === 2) neighbours++;
				if (r < rows - 1 && raw[(r + 1) * cols + c] === 2) neighbours++;
				if (c > 0 && raw[r * cols + c - 1] === 2) neighbours++;
				if (c < cols - 1 && raw[r * cols + c + 1] === 2) neighbours++;
				if (neighbours >= 2) strays++;
			}
		}
		if (strays < 4) return 0;
		// Divided by a floor, not by inCount alone: an outline that has
		// collapsed to a sliver contains almost nothing, and dividing by
		// almost nothing is how a collapse ends up looking unremarkable.
		return strays / Math.max(inCount, 12);
	}

	// Fold this frame's change into both memories. Runs in every state: the
	// long mask has to keep filling in while locked, or the first fresh look
	// after a lost lock would be judged against stale evidence.
	observeChange(change, light) {
		this.filtered ??= makeGray(this.w, this.h);
		const { w, h } = this;
		const d = change.data, f = this.filtered.data, g = light.data;
		const long = this.longChange, decay = this.longDecay;
		const allow = Math.max(this.edgeFloorAllowance, this.edgeAllowance * this.cameraMotion);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = y * w + x;
				// Local gradient magnitude, clamped at the edges of the frame.
				const gx = Math.abs(g[i + (x < w - 1 ? 1 : 0)] - g[i - (x > 0 ? 1 : 0)]);
				const gy = Math.abs(g[i + (y < h - 1 ? w : 0)] - g[i - (y > 0 ? w : 0)]);
				const floor = this.changeFloor + allow * (gx + gy);
				const value = d[i] - floor;
				f[i] = value > 0 ? d[i] : 0;
				const faded = long[i] * decay;
				long[i] = value > faded ? value : faded;
			}
		}
		this.changeAcquirer.push(this.filtered);
		// The still map: change seen while the phone reported that it did not
		// move. Residue at a hard edge exists only when the camera moves, so a
		// map built from these moments is about things that move by
		// themselves - which is the definition of a screen and the opposite of
		// a wall. Without a gyroscope there is no trustworthy way to know a
		// frame was still, so this stays empty and nothing below uses it.
		if (this.sensor?.still) {
			this.stillActivity ??= new Acquirer(this.w, this.h, {
				decay: 0.985, minFill: 0.5, minStep: 12, threshold: 12,
			});
			this.stillActivity.push(this.filtered);
			this.stillFrames++;
		}
	}

	// A coarse map of where a film is playing: block-max the change peak down
	// by coarseStep, then OPEN it - erode, then dilate.
	//
	// Both halves earn their place. Without the dilation, a real film never
	// looks like a screen: measured off a recording of a dance performance on
	// a television, the pixels changing at any moment were 1.5% of the view
	// and filled less than half their own outline, and the app searched for
	// three seconds at something plainly playing. Without the erosion first,
	// the dilation fuses that blob with whatever residue lies near it - the
	// edge of a keyboard, the frame of a picture - and the outline swallows
	// the furniture. Residue is thin: a line one or two cells wide dies in the
	// erosion. A screen is a region, and survives it.
	buildCoarse() {
		const { coarseW: cw, coarseH: ch, coarseStep: step, coarse, coarseSwap } = this;
		// Prefer evidence gathered while the phone was still, once there is
		// enough of it to be worth preferring.
		const peak = this.stillFrames >= this.stillEnough ? this.stillActivity.peak : this.changeAcquirer.peak;
		const floor = this.coarseAcquirer.threshold;
		coarse.fill(0);
		for (let y = 0; y < this.h; y++) {
			const cy = (y / step) | 0;
			for (let x = 0; x < this.w; x++) {
				const v = peak[y * this.w + x];
				const i = cy * cw + ((x / step) | 0);
				if (v > coarse[i]) coarse[i] = v;
			}
		}
		const live = (buf, x, y) => (x < 0 || y < 0 || x >= cw || y >= ch ? 0 : buf[y * cw + x] >= floor ? 1 : 0);
		// Erode: keep only cells with company on at least three sides.
		for (let y = 0; y < ch; y++) {
			for (let x = 0; x < cw; x++) {
				const i = y * cw + x;
				const neighbours = live(coarse, x - 1, y) + live(coarse, x + 1, y)
					+ live(coarse, x, y - 1) + live(coarse, x, y + 1);
				coarseSwap[i] = live(coarse, x, y) && neighbours >= this.coarseErode ? coarse[i] : 0;
			}
		}
		// Dilate twice, restoring the region's own extent and filling the gaps
		// a film leaves between one moment's motion and the next.
		for (let pass = 0; pass < 2; pass++) {
			for (let y = 0; y < ch; y++) {
				for (let x = 0; x < cw; x++) {
					let m = coarseSwap[y * cw + x];
					if (x > 0 && coarseSwap[y * cw + x - 1] > m) m = coarseSwap[y * cw + x - 1];
					if (x < cw - 1 && coarseSwap[y * cw + x + 1] > m) m = coarseSwap[y * cw + x + 1];
					if (y > 0 && coarseSwap[(y - 1) * cw + x] > m) m = coarseSwap[(y - 1) * cw + x];
					if (y < ch - 1 && coarseSwap[(y + 1) * cw + x] > m) m = coarseSwap[(y + 1) * cw + x];
					coarse[y * cw + x] = m;
				}
			}
			coarseSwap.set(coarse);
		}
		return coarse;
	}

	// Mean of a per-pixel source over the coarse grid, inside a quad or - with
	// null - over the whole view.
	gridMean(source, quad = null) {
		const cols = 21, rows = 16;
		let sum = 0, count = 0;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const x = Math.round(((c + 0.5) / cols) * this.w);
				const y = Math.round(((r + 0.5) / rows) * this.h);
				if (quad && !insideQuad(quad, x, y)) continue;
				sum += source[y * this.w + x];
				count++;
			}
		}
		return count ? sum / count : 0;
	}

	// Fraction of a region - a quad's interior, or with null the whole view -
	// where a film has been seen playing.
	changeFill(quad = null) {
		const cols = 21, rows = 16;
		let inside = 0, lit = 0;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const x = Math.round(((c + 0.5) / cols) * this.w);
				const y = Math.round(((r + 0.5) / rows) * this.h);
				if (quad && !insideQuad(quad, x, y)) continue;
				inside++;
				if (this.longChange[y * this.w + x] >= this.changeFloor) lit++;
			}
		}
		return inside ? lit / inside : 0;
	}

	filmSeen() {
		return this.changeFill() >= this.minFilmFraction;
	}

	// Whether a bright blob deserves to be believed as a screen. With no film
	// seen anywhere - a dark cinema during a still scene, a paused video - the
	// answer has to be yes, brightness is all there is. Once a film HAS been
	// seen, the question is containment: a screen contains the film that plays
	// on it, however small a corner of the picture is actually moving (a
	// talking head, a news ticker, one subtitle strip). Only a bright blob
	// with the film substantially OUTSIDE it - a poster beside the television -
	// is furniture. Demanding instead that the film fill the blob rejected
	// every mostly-static film in every dark room, which is most evenings.
	trustLight(quad) {
		if (!this.filmSeen()) return true;
		const cols = 21, rows = 16;
		let film = 0, inside = 0;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const x = Math.round(((c + 0.5) / cols) * this.w);
				const y = Math.round(((r + 0.5) / rows) * this.h);
				if (this.longChange[y * this.w + x] < this.changeFloor) continue;
				film++;
				if (insideQuad(quad, x, y)) inside++;
			}
		}
		return film === 0 || inside / film >= this.minFilmContainment;
	}

	insideRelief() {
		return this.seeking > 0 || this.source !== 'light' ? 0.5 : 1;
	}

	// Roughly the proportions of a screen. A film's activity at one moment can
	// be a horizontal band - a row of dancers, a ticker, a bright horizon -
	// and a six-to-one sliver accepted as a seed is not merely inaccurate: its
	// corners are the intersections of nearly parallel lines, so the smallest
	// correction to one edge throws them across the frame.
	screenShaped(quad) {
		const width = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
		const height = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
		if (!(width > 0 && height > 0)) return false;
		const ratio = width / height;
		return ratio >= this.minSeedRatio && ratio <= this.maxSeedRatio;
	}

	// A change-sourced candidate has to look like a picture on the light
	// channel too. A blob fused with the ghost of a dark keyboard or a chair
	// passes every shape test on the change map and then locks a third of its
	// interior onto furniture; the light channel sees that furniture plainly.
	interiorLooksLit(gray, quad) {
		const stats = this.interiorStats(gray, quad);
		if (!stats.count) return false;
		const cols = 21, rows = 16;
		let dead = 0, inside = 0;
		const limit = stats.median * 0.4;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const x = Math.round(((c + 0.5) / cols) * this.w);
				const y = Math.round(((r + 0.5) / rows) * this.h);
				if (!insideQuad(quad, x, y)) continue;
				inside++;
				// Dark AND never once seen to change. Darkness alone condemns
				// every night scene ever filmed; a dark stage between dancers
				// still lights up the memory over a few seconds, while a
				// keyboard fused into the outline by motion ghosts never does.
				if (gray.data[y * gray.w + x] < limit
					&& this.longChange[y * this.w + x] < this.changeFloor) dead++;
			}
		}
		return inside === 0 || dead / inside <= 0.25;
	}

	// What the picture inside the outline looks like: its mean, and its median.
	//
	// The mean answers "is this still a lit screen at all", which is what tells
	// someone zoomed in past every edge apart from a screen that has gone dark.
	// The median answers "how bright is the picture", and is the reference the
	// edge search uses to skip past the unlit margins of a projection screen.
	// It has to be the median rather than the mean because film content is not
	// uniform - one bright object in a dark shot should not raise the bar for
	// what counts as picture.
	interiorStats(gray, quad) {
		const cols = 21, rows = 16;
		const values = [];
		let sum = 0;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const x = Math.round(((c + 0.5) / cols) * this.w);
				const y = Math.round(((r + 0.5) / rows) * this.h);
				if (!insideQuad(quad, x, y)) continue;
				const value = gray.data[y * gray.w + x];
				values.push(value);
				sum += value;
			}
		}
		if (!values.length) return { mean: 0, median: 0, count: 0 };
		values.sort((a, b) => a - b);
		return { mean: sum / values.length, median: values[values.length >> 1], count: values.length };
	}

	// The measured shape of the screen, averaged over time.
	//
	// The vanishing-point construction is exact when it works and unstable when
	// the view drifts towards straight-on: a handful of frames in every few
	// hundred come back degenerate even while tracking is perfect, and blending
	// those in visibly stretches the picture. Ones that came out clamped, or
	// that had to borrow an assumed focal length, are therefore dropped.
	//
	// Readings that merely disagree are damped almost to nothing rather than
	// rejected, and counted. A lone spike then moves the output by a fraction
	// of a percent, while a long run of them means the stored value is the
	// thing that is wrong - one unlucky reading at the moment of lock - and it
	// is replaced outright. Rejecting outliers without that escape hatch would
	// leave the picture permanently stretched, because every later reading,
	// including all the correct ones, would look like the outlier.
	updateAspect(quad, immediate = false) {
		const est = estimateAspect(quad, {
			principal: [this.w / 2, this.h / 2],
			focal: this.assumedFocal,
		});
		if (!est || est.clamped || est.method === 'assumed-focal') return;
		if (this.aspect === null || immediate) {
			this.aspect = est.aspect;
			this.aspectMethod = est.method;
			return;
		}
		const disagreement = Math.abs(Math.log(est.aspect / this.aspect));
		if (disagreement <= this.aspectJump) {
			this.aspectDoubt = 0;
			this.aspect += (est.aspect - this.aspect) * this.aspectSmoothing;
		} else if (++this.aspectDoubt >= this.aspectDoubtLimit) {
			this.aspect = est.aspect;
			this.aspectDoubt = 0;
		} else {
			this.aspect += (est.aspect - this.aspect) * this.aspectSmoothing * this.outlierWeight;
		}
		this.aspectMethod = est.method;
	}

	/**
	 * @param {object} frame one camera frame's worth of evidence
	 * @param {{data:Uint8ClampedArray,w:number,h:number}} frame.light the
	 *   brightness channel
	 * @param {{data:Uint8ClampedArray,w:number,h:number}|null} frame.change
	 *   motion-compensated difference against a rolling reference; null on the
	 *   first frame, on pans, on exposure ramps, and in callers that have
	 *   nothing better - everything then falls back to light
	 * @param {number} frame.motion the camera's frame-to-frame motion in
	 *   pixels as measured from the picture itself
	 * @param {{shift:number, still:boolean}|null} frame.sensor the same
	 *   question asked of the gyroscope, which no film can mislead
	 */
	update(frame) {
		const { light, change = null, motion = 0, restless = 0, warp = 0, sensor = null } = frame;
		this.frame++;
		this.changeFrame = change;
		// Where the two disagree, believe whichever saw more: a pixel estimate
		// can be dragged low by a film filling the view, and a gyroscope sees
		// nothing of a camera sliding sideways.
		this.cameraMotion = sensor ? Math.max(sensor.shift, motion) : motion;
		this.sensor = sensor;
		this.restless = restless;
		this.warp = warp;
		if (change) this.observeChange(change, light);
		// A refused frame with real motion behind it means the peak memory is
		// full of pan smear; it takes half a second to decay below threshold
		// on its own, and every one of those frames is a blind one. Wipe it.
		else if (motion >= 1.5) this.changeAcquirer.reset();
		this._lastLight = light;
		return this.state === LOCKED ? this.follow(light) : this.search(light);
	}

	// Refine the outline we already have against this frame.
	follow(gray) {
		const { start } = this.predict();
		// How bright the picture is right now, so the edge search can tell the
		// film from the unlit screen around it.
		const inside = this.interiorStats(gray, this.measured ?? start);
		const tracked = trackQuad(gray, start, {
			...this.trackOpts,
			// While seeking, the bar for "this is picture" comes down. An
			// outline seeded on the bright half of a screen takes its own
			// interior as the standard and then refuses to grow into the dim
			// half - a stage lit red below and blue above is enough to do it -
			// so the screen it settles on is the part it started with. Once
			// settled the full bar returns, which is what keeps a projection
			// screen's unlit margins outside the outline.
			// The bar for "this is picture, not the margin around it" is high
			// only where it was earned. It exists for a projection screen,
			// whose unlit surround is brighter than the night behind it and
			// makes a perfectly good false edge - and such a screen is always
			// found by brightness, in a dark room. A set found by its motion
			// is a different case: the room is lit, the picture may be dim at
			// one border, and an outline that takes its own bright half as the
			// standard will refuse to grow into the dark half and sit there
			// permanently cropped.
			minInside: inside.median * this.insideFactor * this.insideRelief(),
			maxEdgeJump: this.edgeJump,
			// A fresh lock looks further for its edges, for long enough to walk
			// to them. Acquisition from change undersizes a screen whose
			// picture is dim near one border - the blob simply stops where the
			// film stops changing - and the ordinary search radius cannot see
			// a bezel thirty pixels away. Nothing leaps: the per-frame jump
			// stays clamped, so the outline walks out over a second at most.
			// Afterwards the reach comes back in, which is what keeps a
			// projection screen's unlit margins out of the outline.
			radius: this.seeking > 0
				? Math.round(this.trackOpts.radius * this.seekReach)
				: this.trackOpts.radius,
		});
		if (this.seeking > 0) this.seeking--;
		if (!tracked || !this.plausible(tracked.quad)) return this.miss(gray);
		this.edges = tracked.edges;

		if (tracked.edges === 0) {
			// No edge to measure. If there is still a lit picture inside the
			// outline, this is someone zoomed in past every edge: carry on from
			// the prediction, whose velocity decays frame by frame so it coasts
			// to a halt rather than sailing off, and give that a couple of
			// seconds. If the middle has gone dark too, the screen is off or
			// covered, and that is a miss, not a zoom.
			if (this.interiorStats(gray, tracked.quad).mean < this.minInteriorLuma) return this.miss(gray);
			this.blind++;
			if (this.blind > this.maxBlindFrames) return this.lose(gray);
			this.confidence = 0;
			this.coast *= this.coastDecay;
			if (this.velocity) this.velocity = this.velocity.map(([x, y]) => [x * 0.7, y * 0.7]);
			this.measured = tracked.quad;
			this.quad = this.smoother.update(this.measured);
			return this.report();
		}

		// Something bright AND playing, sitting outside the outline, for several
		// frames together while the camera is steady: the outline has been
		// dragged off the screen and no amount of local refinement will bring
		// it back. Start again. Steadiness is the CAMERA's, measured by the
		// change tracker - never the outline's own velocity, which is exactly
		// what a runaway outline controls. Without a change frame (a pan, an
		// exposure ramp, an old caller) there is no way to ask this safely, so
		// it is not asked.
		if (this.changeFrame && this.cameraMotion < this.velocityGate) {
			// Leaky, not consecutive: hand tremor oscillates across the motion
			// gate, and a consecutive counter reset on every gated frame could
			// never fire while the very tremor that needs rescuing continued.
			if (this.strayLight(gray, tracked.quad) > this.strayLimit) {
				if (++this.stray > this.strayFrames) return this.lose(gray);
			} else {
				this.stray = Math.max(0, this.stray - 1);
			}
		}

		// A lock whose interior stays bimodal on the light channel - part
		// picture, part furniture - is wrong, however confidently it tracks.
		// This is what actually corrects a lock that formed on a ghost-fused
		// blob: the stray check cannot see INSIDE the outline, and the edges
		// of a wrong quad often sit on perfectly real contrast. Judged over
		// several looks so one dark movie scene cannot trigger it.
		if (this.frame % this.sanityEvery === 0) {
			if (!this.interiorLooksLit(gray, tracked.quad)) {
				if (++this.interiorDoubt >= 3) return this.lose(gray);
			} else {
				this.interiorDoubt = 0;
			}
		}

		this.misses = 0;
		this.blind = 0;
		this.settled = tracked.edges >= 3 ? this.settled + 1 : 0;
		this.confidence = tracked.confidence;
		// Velocity is evidence only for a corner that sits on an edge the
		// tracker actually measured this frame; a corner on unmeasured edges
		// follows the prediction exactly, so velocity read off it is the
		// prediction feeding itself - left alone, that inflated a lock to
		// three times its size with the camera sitting still. The free corners
		// instead extrapolate through a similarity fitted to the pinned ones:
		// one camera moves everything together, so scale and translation
		// measured on real corners carry honestly to the rest - a zoom's
		// outward growth is captured, a phantom dies on the pins.
		// The motion model is built from exactly what the measured edges can
		// testify to: their PERPENDICULAR displacement. A line pins nothing
		// along itself, and any model that reads corner deltas swallows the
		// unconstrained parallel component - which is the prediction feeding
		// itself, and it flung the free corners of a lock a hundred pixels up
		// a wall under nothing but hand tremor. Perpendicular displacements
		// fit a translation plus a uniform scale about the centroid: two
		// opposite edges separating is a zoom, all edges shifting together is
		// a pan, and the direction no edge can see honestly stays put.
		if (this.seeking > 0) {
			// No extrapolation while the outline is still finding its edges.
			// The motion model reads a uniform scale out of perpendicular
			// displacements, and a seed correcting one edge at a time looks
			// exactly like a zoom: the top edge walking up to the bezel was
			// enough to push the left edge eighty pixels off the frame.
			// Nothing here is the camera moving - it is the outline arriving.
			this.velocity = null;
			this.coast = 1;
		} else if (tracked.edges >= 1 && this.measured) {
			this.coast = 1;
			const c = [0, 1].map((axis) => this.measured.reduce((a, p) => a + p[axis], 0) / 4);
			// Normal equations for (tx, ty, s), ridge-regularised.
			const AtA = [[0.01, 0, 0], [0, 0.01, 0], [0, 0, 0.01]];
			const Atb = [0, 0, 0];
			for (let e = 0; e < 4; e++) {
				if (!tracked.seen[e]) continue;
				const [nx, ny] = inwardNormal(this.measured, e);
				const mx = (this.measured[e][0] + this.measured[(e + 1) % 4][0]) / 2;
				const my = (this.measured[e][1] + this.measured[(e + 1) % 4][1]) / 2;
				const nmx = (tracked.quad[e][0] + tracked.quad[(e + 1) % 4][0]) / 2;
				const nmy = (tracked.quad[e][1] + tracked.quad[(e + 1) % 4][1]) / 2;
				const delta = (nmx - mx) * nx + (nmy - my) * ny;
				const lever = (mx - c[0]) * nx + (my - c[1]) * ny;
				const row = [nx, ny, lever];
				for (let i = 0; i < 3; i++) {
					Atb[i] += row[i] * delta;
					for (let j = 0; j < 3; j++) AtA[i][j] += row[i] * row[j];
				}
			}
			const solved = solve3(AtA, Atb);
			this.velocity = solved
				? this.measured.map((p) => [
					clampAbs(solved[0] + solved[2] * (p[0] - c[0]), 8),
					clampAbs(solved[1] + solved[2] * (p[1] - c[1]), 8),
				])
				: null;
		} else {
			this.coast *= this.coastDecay;
			if (this.velocity) this.velocity = this.velocity.map(([x, y]) => [x * 0.7, y * 0.7]);
		}
		this.measured = tracked.quad;
		this.checkForSlippage(gray);
		this.quad = this.smoother.update(this.measured);
		this.updateAspect(this.quad);
		return this.report();
	}

	// A frame that said nothing useful: hold the outline for a moment - a hand
	// crossing the lens, one dark cut - and let go only if it keeps saying
	// nothing.
	miss(gray) {
		this.misses++;
		this.confidence = 0;
		// No idea what happened, so stop extrapolating and hold still.
		this.velocity = null;
		return this.misses <= this.maxMisses ? this.report() : this.lose(gray);
	}

	// Look for a screen with no prior guess.
	//
	// Brightness leads, change arbitrates. The bright blob is the screen in
	// every dark room, including ones showing a mostly-static film whose
	// change evidence is a face-sized patch - so a bright candidate that
	// CONTAINS the film wins outright. The change candidate is the answer only
	// where brightness has none: the lit room, where the wall out-shines the
	// picture and the light acquirer returns nothing usable. Preferring change
	// outright locked onto subtitle strips.
	search(gray) {
		this.searchFrames++;
		this.acquirer.push(gray);

		let found = null;
		let source = null;

		const bright = this.acquirer.detect();
		if (bright && this.plausible(bright)) {
			if (this.trustLight(bright)) {
				found = bright;
				source = 'light';
			} else {
				// Vetoed by film containment - but a veto is built on the change
				// memory, and that memory can be wrong in one specific way: a
				// passing person stamps a trail of real change across places
				// that are not screens. A bright quad that stays put for a full
				// second while nothing else in the frame is lockable is
				// stronger evidence than a fading trail.
				// A coarser match than lock probation uses: the question is
				// whether the same REGION keeps being the only bright thing,
				// not whether its corners are pixel-stable - film content
				// makes a bright blob's corners flap.
				const tol = 0.08 * Math.hypot(this.w, this.h);
				if (this.vetoed && quadsClose(bright, this.vetoed, tol)) this.vetoedHits++;
				else this.vetoedHits = 1;
				this.vetoed = bright;
				if (this.vetoedHits >= 24) {
					found = bright;
					source = 'light';
				}
			}
		}
		if (!found && this.changeFrame && this.filmSeen()) {
			const small = this.coarseAcquirer.detect(this.buildCoarse());
			const moving = small ? small.map(([x, y]) => [x * this.coarseStep, y * this.coarseStep]) : null;
			if (moving && this.plausible(moving) && this.screenShaped(moving)
				&& this.interiorLooksLit(gray, moving)) {
				found = moving;
				source = 'change';
			}
		}

		// One good-looking frame is not enough: a passing reflection can produce
		// a convincing quad. Require the same outline several times over - but
		// tolerate gaps. The change channel breathes with the film (a quiet
		// stretch between cuts thins the blob for a few frames), and resetting
		// the count to zero on every gap would keep a perfectly stable
		// candidate on probation forever.
		if (!found) {
			if (++this.candidateMisses > 4) {
				this.candidate = null;
				this.candidateHits = 0;
			}
			return this.report();
		}
		this.candidateMisses = 0;
		const tol = 0.03 * Math.hypot(this.w, this.h);
		if (this.candidate && quadsClose(found, this.candidate, tol)) this.candidateHits++;
		else this.candidateHits = 1;
		this.candidate = found;
		if (this.candidateHits >= this.stableFrames) {
			this.state = LOCKED;
			this.misses = 0;
			this.blind = 0;
			this.confidence = 0.5;
			this.measured = found;
			this.velocity = null;
			this.coast = 1;
				// A lock from the light channel is exact - the blob IS the lit
			// picture - so its edges are immediately held to small moves, which
			// is what keeps them off a projection screen's unlit margins. A
			// lock from the change channel is conservative: quiet parts of the
			// film leave the blob ragged, and the tracker needs a moment of
			// freedom to snap outward onto the true edges.
			this.settled = source === 'change' ? 0 : this.settleFrames;
			// A change-sourced outline is a seed, not an answer: give it time
			// to find the real edges before the reach narrows.
			this.seeking = source === 'change' ? this.seekFrames : 0;
			this.source = source;
			this.searchFrames = 0;

			this.smoother.reset(found);
			this.quad = this.smoother.quad;
			this.updateAspect(this.quad, true);
			this.candidate = null;
			this.candidateHits = 0;
		}
		return this.report();
	}

	// Give up the lock and start looking again. Returns a report so callers can
	// treat it as the frame's answer.
	lose(gray = null) {
		this.state = SEARCHING;
		this.quad = null;
		this.measured = null;
		this.velocity = null;
		this.coast = 1;
		this.stray = 0;
		this.settled = 0;
		this.interiorDoubt = 0;
		this.candidate = null;
		this.candidateHits = 0;
		this.candidateMisses = 0;
		this.vetoed = null;
		this.vetoedHits = 0;
		this.blind = 0;
		this.edges = 0;
		this.confidence = 0;

		this.acquirer.reset();
		this.changeAcquirer.reset();
		this.smoother.reset();
		return gray ? this.search(gray) : this.report();
	}

	// Tracking is a local search, so it can only ever be wrong locally - except
	// in one way: if the outline slips inside the picture it can settle on some
	// bright shape in the film and follow that instead, quite happily and with
	// high confidence. Every so often, compare against what a fresh look at the
	// frame says: the lit area cannot suddenly be much larger than the screen.
	checkForSlippage(gray) {
		if (this.sanityEvery <= 0 || this.frame % this.sanityEvery !== 0) return;
		// Only meaningful while the whole screen is in view: once it overflows
		// the frame, a fresh look can only ever find the viewport.
		if (this.measured.some(([x, y]) => x < 0 || y < 0 || x > this.w - 1 || y > this.h - 1)) return;
		const fresh = this.acquirer.detectSingle(gray);
		if (!fresh || !this.plausible(fresh)) return;
		// The fresh look is a brightness look, and in a lit room the brightest
		// coherent blob is the room. Adopting it would hand a perfectly good
		// outline to the wall, so it faces the same question as any bright
		// blob: is the film in it?
		if (!this.trustLight(fresh)) return;
		if (quadArea(fresh) > this.sanityGrowth * quadArea(this.measured)) {
			this.measured = fresh;

			this.smoother.reset(fresh);
			this.slips++;
		}
	}

	report() {
		return {
			state: this.state,
			quad: this.quad,
			candidate: this.candidate,
			confidence: this.confidence,
			aspect: this.aspect,
			slips: this.slips,
			restless: this.restless,
			edges: this.edges,
			blind: this.blind,
			source: this.source,
			sensor: this.sensor ? (this.sensor.still ? 'still' : 'moving') : null,
			stillFrames: this.stillFrames,
			searchFrames: this.searchFrames,
			coasting: this.state === LOCKED && (this.misses > 0 || this.blind > 0),
		};
	}
}
