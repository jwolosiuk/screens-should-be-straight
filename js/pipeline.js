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
		this.aspectMethod = null;
		this.aspectDoubt = 0;
		this.slips = 0;
		this.frame = 0;
		this.searchFrames = 0;
		this.clippedStreak = 0;
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
		this.stray = 0;
		this.blind = 0;
		this.searchFrames = 0;
		this.clippedStreak = 0;
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
		const peak = this.changeAcquirer.peak;
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
	observeChange(change) {
		this.changeAcquirer.push(change);
		const long = this.longChange, d = change.data, floor = this.changeFloor, decay = this.longDecay;
		for (let i = 0; i < long.length; i++) {
			const faded = long[i] * decay;
			const value = d[i] - floor;
			long[i] = value > faded ? value : faded;
		}
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

	// A change-sourced candidate has to look like a picture on the light
	// channel too. A blob fused with the ghost of a dark keyboard or a chair
	// passes every shape test on the change map and then locks a third of its
	// interior onto furniture; the light channel sees that furniture plainly.
	interiorLooksLit(gray, quad) {
		const stats = this.interiorStats(gray, quad);
		if (!stats.count) return false;
		const cols = 21, rows = 16;
		let dark = 0, inside = 0;
		const limit = stats.median * 0.4;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const x = Math.round(((c + 0.5) / cols) * this.w);
				const y = Math.round(((r + 0.5) / rows) * this.h);
				if (!insideQuad(quad, x, y)) continue;
				inside++;
				if (gray.data[y * gray.w + x] < limit) dark++;
			}
		}
		return inside === 0 || dark / inside <= 0.15;
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
	 * @param {{data:Uint8ClampedArray, w:number, h:number}} light current frame
	 * @param {{data:Uint8ClampedArray, w:number, h:number}|null} change
	 *   motion-compensated difference against a rolling reference; null on the
	 *   first frame, on pans, on exposure ramps, and in callers that have
	 *   nothing better - everything then falls back to light.
	 * @param {number} motion the camera's own frame-to-frame motion in pixels,
	 *   as measured by the ChangeTracker - NOT derived from the outline, which
	 *   a runaway outline controls.
	 */
	update(light, change = null, motion = 0, restless = 0) {
		this.frame++;
		this.changeFrame = change;
		this.cameraMotion = motion;
		this.restless = restless;
		if (change) this.observeChange(change);
		// A refused frame with real motion behind it means the peak memory is
		// full of pan smear; it takes half a second to decay below threshold
		// on its own, and every one of those frames is a blind one. Wipe it.
		else if (motion >= 1.5) this.changeAcquirer.reset();
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
			minInside: inside.median * this.insideFactor,
			maxEdgeJump: this.edgeJump,
		});
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
		if (tracked.edges >= 1 && this.measured) {
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
		let clip = false;

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
		let sawCandidate = found !== null;
		if (!found && this.changeFrame && this.filmSeen()) {
			const moving = this.changeAcquirer.detect();
			if (moving && this.plausible(moving) && this.interiorLooksLit(gray, moving)) {
				found = moving;
				source = 'change';
				sawCandidate = true;
			} else {
				clip = this.changeAcquirer.clipped || this.changeAcquirer.overflow
					|| this.changeAcquirer.touchesBorders >= 2;
			}
		}
		// A static screen larger than the view: no film to see, but a single
		// bright blob swallowing over ninety percent of the frame is its own
		// signature. (Content the change channel cannot map at all - a fast pan
		// filling the view - gets no hint; it falls through to the Adjust
		// suggestion, which is less specific but never wrong.)
		if (!found && !this.filmSeen()) clip = clip || this.acquirer.overflow;

		// Evidence for, candidates against, and silence is neutral. The clip
		// signal is periodic by nature - loud just after a shot cut, quiet
		// between cuts, absent on frames where content motion masquerades as a
		// pan - so consecutive-frame debouncing could never accumulate it. A
		// frame that produced an actual screen candidate argues the framing is
		// fine; a frame that produced nothing at all argues nothing.
		if (clip) this.clippedStreak = Math.min(20, this.clippedStreak + 3);
		else if (sawCandidate) this.clippedStreak = Math.max(0, this.clippedStreak - 1);

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
			this.source = source;
			this.searchFrames = 0;
			this.clippedStreak = 0;

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
			// Only the change channel earns this message: it means a playing
			// picture demonstrably runs off the side of the view. The light
			// channel used to say it about a bedroom wall.
			clipped: this.state === SEARCHING && this.clippedStreak >= 12,
			source: this.source,
			searchFrames: this.searchFrames,
			coasting: this.state === LOCKED && (this.misses > 0 || this.blind > 0),
		};
	}
}
