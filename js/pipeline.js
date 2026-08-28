// The acquire -> track -> verify loop, with no DOM in sight so it can be
// driven by synthetic frames in the tests.
//
// Acquisition is expensive and needs a moment of stillness; tracking is cheap
// and tolerates motion but needs a starting outline. So the pipeline stays in
// tracking for as long as the outline keeps passing its sanity checks, and
// falls back to acquisition only after several consecutive bad frames - a
// hand passing in front of the screen or one dark cut should not cost the
// lock.

import { Acquirer, insideQuad } from './detect.js';
import { dist, isConvex, quadArea, quadsClose } from './geom.js';
import { QuadSmoother } from './smooth.js';
import { defaultRadius, trackQuad } from './track.js';
import { estimateAspect, focalFromFov } from './aspect.js';

export const SEARCHING = 'searching';
export const LOCKED = 'locked';

export class ScreenPipeline {
	constructor(w, h, opts = {}) {
		this.w = w;
		this.h = h;
		this.acquirer = new Acquirer(w, h, opts.acquire);
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
		this.minEdgeFrac = opts.minEdgeFrac ?? 0.06;
		this.minAreaFrac = opts.minAreaFrac ?? 0.02;
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
		this.strayBrightness = opts.strayBrightness ?? 0.75;
		this.strayFrames = opts.strayFrames ?? 3;
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
		this.measured = null;
		this.velocity = null;
		this.coast = 1;
		this.stray = 0;
		this.aspectMethod = null;
		this.aspectDoubt = 0;
		this.slips = 0;
		this.frame = 0;
		this.acquirer.reset();
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

	// Lit picture that the outline has left out, as a fraction of the lit area
	// it contains.
	//
	// Individual edge checks can only ask "did this edge move oddly", and an
	// obstruction that creeps along at a few pixels a frame never looks odd on
	// any single frame - it just quietly takes the outline with it. This asks
	// the question that stays answerable however slow the theft is: is there
	// still screen out there that we have stopped calling screen?
	strayLight(gray, quad) {
		const cols = 21, rows = 16;
		let inSum = 0, inCount = 0;
		const outside = [];
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const x = Math.round(((c + 0.5) / cols) * this.w);
				const y = Math.round(((r + 0.5) / rows) * this.h);
				const value = gray.data[y * gray.w + x];
				if (insideQuad(quad, x, y)) { inSum += value; inCount++; }
				else outside.push(value);
			}
		}
		if (inCount < 3 || !outside.length) return 0;
		const lit = (inSum / inCount) * this.strayBrightness;
		// Divided by a floor, not by inCount alone: an outline that has
		// collapsed to a sliver contains almost nothing, and dividing by
		// almost nothing is how a collapse ends up looking unremarkable.
		return outside.filter((v) => v >= lit).length / Math.max(inCount, 12);
	}

	// Mean luminance inside the outline, over the part of it that is in view.
	// This is what separates "zoomed in past every edge" from "the screen went
	// black": both leave no edge to measure, but only one of them still has a
	// lit picture in the middle, and only one of them is worth coasting on.
	interiorLuma(gray, quad) {
		const cols = 21, rows = 16;
		let sum = 0, count = 0;
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const x = Math.round(((c + 0.5) / cols) * this.w);
				const y = Math.round(((r + 0.5) / rows) * this.h);
				if (!insideQuad(quad, x, y)) continue;
				sum += gray.data[y * gray.w + x];
				count++;
			}
		}
		return count ? sum / count : 0;
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

	/** @param {{data:Uint8ClampedArray, w:number, h:number}} gray current frame */
	update(gray) {
		this.frame++;
		return this.state === LOCKED ? this.follow(gray) : this.search(gray);
	}

	// Refine the outline we already have against this frame.
	follow(gray) {
		const { start } = this.predict();
		const tracked = trackQuad(gray, start, this.trackOpts);
		if (!tracked || !this.plausible(tracked.quad)) return this.miss(gray);
		this.edges = tracked.edges;

		if (tracked.edges === 0) {
			// No edge to measure. If there is still a lit picture inside the
			// outline, this is someone zoomed in past every edge: carry on from
			// the prediction, whose velocity decays frame by frame so it coasts
			// to a halt rather than sailing off, and give that a couple of
			// seconds. If the middle has gone dark too, the screen is off or
			// covered, and that is a miss, not a zoom.
			if (this.interiorLuma(gray, tracked.quad) < this.minInteriorLuma) return this.miss(gray);
			this.blind++;
			if (this.blind > this.maxBlindFrames) return this.lose(gray);
			this.confidence = 0;
			this.coast *= this.coastDecay;
			this.measured = tracked.quad;
			this.quad = this.smoother.update(this.measured);
			return this.report();
		}

		// Something as bright as the screen, sitting outside the outline, for
		// several frames together: the outline has been dragged off the screen
		// and no amount of local refinement will bring it back. Start again.
		if (this.strayLight(gray, tracked.quad) > this.strayLimit) {
			if (++this.stray > this.strayFrames) return this.lose(gray);
		} else {
			this.stray = 0;
		}

		this.misses = 0;
		this.blind = 0;
		this.coast = 1;
		this.confidence = tracked.confidence;
		// What was predicted, plus the correction the visible edges asked for.
		this.velocity = this.measured ? tracked.quad.map((p, i) => [p[0] - this.measured[i][0], p[1] - this.measured[i][1]]) : null;
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
	search(gray) {
		this.acquirer.push(gray);
		const found = this.acquirer.detect();
		if (!found || !this.plausible(found)) {
			this.candidate = null;
			this.candidateHits = 0;
			return this.report();
		}
		// One good-looking frame is not enough: a passing reflection can produce
		// a convincing quad. Require the same outline several times over.
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
		this.candidate = null;
		this.candidateHits = 0;
		this.blind = 0;
		this.edges = 0;
		this.confidence = 0;

		this.acquirer.reset();
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
			edges: this.edges,
			blind: this.blind,
			clipped: this.state === SEARCHING && this.acquirer.clipped === true,
			coasting: this.state === LOCKED && (this.misses > 0 || this.blind > 0),
		};
	}
}
