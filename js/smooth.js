// Corner smoothing.
//
// Two demands pull in opposite directions: standing still, the measurement
// wobbles by a fraction of a pixel per frame and the un-warped picture must
// not shimmer; panning, any lag shows up as the image sliding around. So the
// filter gain follows the measured motion - heavy smoothing when still, nearly
// transparent when moving - and a large jump (a re-acquire on a different
// screen) snaps through instead of gliding across the room.

import { dist } from './geom.js';

export class QuadSmoother {
	constructor(opts = {}) {
		this.minAlpha = opts.minAlpha ?? 0.18;
		this.maxAlpha = opts.maxAlpha ?? 0.92;
		this.gain = opts.gain ?? 0.12;
		this.snapDistance = opts.snapDistance ?? 60;
		this.quad = null;
	}

	reset(quad = null) {
		this.quad = quad ? quad.map((p) => [p[0], p[1]]) : null;
	}

	update(measured) {
		if (!this.quad) {
			this.reset(measured);
			return this.quad;
		}
		const motion = measured.reduce((s, p, i) => s + dist(p, this.quad[i]), 0) / 4;
		const alpha = motion > this.snapDistance
			? 1
			: Math.min(this.maxAlpha, Math.max(this.minAlpha, this.minAlpha + this.gain * motion));
		this.quad = this.quad.map((p, i) => [
			p[0] + (measured[i][0] - p[0]) * alpha,
			p[1] + (measured[i][1] - p[1]) * alpha,
		]);
		return this.quad;
	}
}
