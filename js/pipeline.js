// The acquire -> track -> verify loop, with no DOM in sight so it can be
// driven by synthetic frames in the tests.
//
// Acquisition is expensive and needs a moment of stillness; tracking is cheap
// and tolerates motion but needs a starting outline. So the pipeline stays in
// tracking for as long as the outline keeps passing its sanity checks, and
// falls back to acquisition only after several consecutive bad frames - a
// hand passing in front of the screen or one dark cut should not cost the
// lock.

import { Acquirer } from './detect.js';
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
		this.minEdgeFrac = opts.minEdgeFrac ?? 0.06;
		this.minAreaFrac = opts.minAreaFrac ?? 0.02;
		// Slow, and gated against sudden changes: the first estimate at lock is
		// taken as-is, and after that a real screen keeps the shape it had.
		this.aspectSmoothing = opts.aspectSmoothing ?? 0.06;
		this.aspectJump = opts.aspectJump ?? Math.log(1.25);
		this.outlierWeight = opts.outlierWeight ?? 0.15;
		this.lead = opts.lead ?? 0.8;
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
		this.candidate = null;
		this.candidateHits = 0;
		this.measured = null;
		this.previous = null;
		this.aspectMethod = null;
		this.slips = 0;
		this.frame = 0;
		this.acquirer.reset();
		this.smoother.reset();
	}

	// Where the corners will be next frame if they keep doing what they just
	// did. The tracker searches around this, not around the smoothed outline:
	// smoothing lags behind real motion, and an outline that lags ends up
	// inside the picture, where it happily locks onto a moving shot instead of
	// the edge of the screen.
	prediction() {
		if (!this.measured) return null;
		if (!this.previous) return this.measured;
		return this.measured.map((p, i) => [
			p[0] + (p[0] - this.previous[i][0]) * this.lead,
			p[1] + (p[1] - this.previous[i][1]) * this.lead,
		]);
	}

	// Hand the pipeline an outline from outside - the user dragging the corner
	// handles - and go straight to tracking.
	seed(quad) {
		if (!quad || quad.length !== 4 || !isConvex(quad)) return false;
		this.measured = quad.map((p) => [p[0], p[1]]);
		this.previous = null;
		this.smoother.reset(quad);
		this.quad = this.smoother.quad;
		this.state = LOCKED;
		this.misses = 0;
		this.confidence = 0.5;
		this.updateAspect(this.quad, true);
		return true;
	}

	plausible(quad) {
		if (!quad || !isConvex(quad)) return false;
		const area = quadArea(quad);
		if (!isFinite(area) || area < this.minAreaFrac * this.w * this.h) return false;
		// Corners may leave the frame when the screen is close, but not by a
		// wild margin - that usually means two edges have crossed.
		const marginX = this.w, marginY = this.h;
		for (const [x, y] of quad) {
			if (!isFinite(x) || !isFinite(y)) return false;
			if (x < -marginX || x > 2 * marginX || y < -marginY || y > 2 * marginY) return false;
		}
		const minEdge = this.minEdgeFrac * Math.min(this.w, this.h);
		for (let i = 0; i < 4; i++) {
			if (dist(quad[i], quad[(i + 1) % 4]) < minEdge) return false;
		}
		return true;
	}

	// The measured shape of the screen, averaged over time.
	//
	// The vanishing-point construction is exact when it works and unstable when
	// the view drifts towards straight-on: a handful of frames in every few
	// hundred come back degenerate even while tracking is perfect, and blending
	// those in visibly stretches the picture. Ones that came out clamped, or
	// that had to borrow an assumed focal length, are therefore dropped.
	//
	// Readings that merely disagree are treated differently from readings that
	// are invalid. They are damped, not rejected: rejecting them outright would
	// mean that one bad value taken at lock could never be corrected, since
	// every later reading - including all the right ones - would look like the
	// outlier. Damped, a lone spike barely moves the output while a persistent
	// disagreement still wins within a few seconds.
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
		const weight = this.aspectSmoothing * (disagreement > this.aspectJump ? this.outlierWeight : 1);
		this.aspect += (est.aspect - this.aspect) * weight;
		this.aspectMethod = est.method;
	}

	/** @param {{data:Uint8ClampedArray, w:number, h:number}} gray current frame */
	update(gray) {
		this.frame++;
		if (this.state === LOCKED) {
			const start = this.prediction() ?? this.quad;
			const tracked = trackQuad(gray, start, this.trackOpts);
			if (tracked && this.plausible(tracked.quad)) {
				this.misses = 0;
				this.confidence = tracked.confidence;
				this.previous = this.measured;
				this.measured = tracked.quad;
				this.checkForSlippage(gray);
				this.quad = this.smoother.update(this.measured);
				this.updateAspect(this.quad);
				return this.report();
			}
			this.misses++;
			// Coast on the last known outline for a few frames before giving up.
			if (this.misses <= this.maxMisses) {
				this.confidence = 0;
				this.previous = null;
				return this.report();
			}
			this.state = SEARCHING;
			this.quad = null;
			this.measured = null;
			this.previous = null;
			this.candidate = null;
			this.candidateHits = 0;
			this.acquirer.reset();
			this.smoother.reset();
		}

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
			this.confidence = 0.5;
			this.measured = found;
			this.previous = null;
			this.smoother.reset(found);
			this.quad = this.smoother.quad;
			this.updateAspect(this.quad, true);
			this.candidate = null;
			this.candidateHits = 0;
		}
		return this.report();
	}

	// Tracking is a local search, so it can only ever be wrong locally - except
	// in one way: if the outline slips inside the picture it can settle on some
	// bright shape in the film and follow that instead, quite happily and with
	// high confidence. Every so often, compare against what a fresh look at the
	// frame says: the lit area cannot suddenly be much larger than the screen.
	checkForSlippage(gray) {
		if (this.sanityEvery <= 0 || this.frame % this.sanityEvery !== 0) return;
		const fresh = this.acquirer.detectSingle(gray);
		if (!fresh || !this.plausible(fresh)) return;
		if (quadArea(fresh) > this.sanityGrowth * quadArea(this.measured)) {
			this.measured = fresh;
			this.previous = null;
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
			coasting: this.state === LOCKED && this.misses > 0,
		};
	}
}
