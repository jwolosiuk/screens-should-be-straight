// Acquisition: find a screen in the frame from scratch, with no prior guess.
//
// The screen is the bright region in a darker room, but a movie is not
// uniformly bright: a dark scene or letterbox bars would carve the region into
// pieces on any single frame. So acquisition works on a slowly decaying
// per-pixel maximum over the last second or so. Anything that lit up recently
// still counts as screen, which is exactly the property we want, and it is
// also why acquisition asks the user to hold still for a moment: the peak
// image smears if the camera moves. Once locked, the tracker takes over and
// motion is fine.

import { convexHull, isConvex, maxAreaQuad, quadArea, simplifyPolygon } from './geom.js';

// Convex quads only, given in canonical order (positive shoelace area).
export function insideQuad(quad, x, y) {
	for (let i = 0; i < 4; i++) {
		const a = quad[i], b = quad[(i + 1) % 4];
		if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
	}
	return true;
}

export function otsuThreshold(hist, total) {
	let sum = 0;
	for (let i = 0; i < 256; i++) sum += i * hist[i];
	let sumB = 0, wB = 0, best = 0, bestVar = -1;
	for (let t = 0; t < 256; t++) {
		wB += hist[t];
		if (wB === 0) continue;
		const wF = total - wB;
		if (wF === 0) break;
		sumB += t * hist[t];
		const mB = sumB / wB, mF = (sum - sumB) / wF;
		const between = wB * wF * (mB - mF) * (mB - mF);
		if (between > bestVar) { bestVar = between; best = t; }
	}
	return best;
}

export class Acquirer {
	constructor(w, h, opts = {}) {
		this.w = w;
		this.h = h;
		this.decay = opts.decay ?? 0.94;
		this.minAreaFrac = opts.minAreaFrac ?? 0.02;
		this.maxAreaFrac = opts.maxAreaFrac ?? 0.9;
		this.minFill = opts.minFill ?? 0.7;
		this.minHullFit = opts.minHullFit ?? 0.85;
		this.minStep = opts.minStep ?? 22;
		this.peak = new Float32Array(w * h);
		this.labels = new Int32Array(w * h);
		this.stack = new Int32Array(w * h);
		this.hist = new Int32Array(256);
	}

	reset() {
		this.peak.fill(0);
	}

	push(gray) {
		const { peak, decay } = this;
		const d = gray.data;
		for (let i = 0; i < peak.length; i++) {
			const faded = peak[i] * decay;
			peak[i] = d[i] > faded ? d[i] : faded;
		}
	}

	// Largest 4-connected blob of pixels above the threshold. Returns its size
	// and, per row, the leftmost and rightmost pixel: the convex hull of a blob
	// only ever uses row-extreme pixels, so this is all the hull needs and it
	// keeps the point set at two per row instead of thousands.
	largestComponent(threshold, source = this.peak) {
		const { w, h, labels, stack } = this;
		const peak = source;
		labels.fill(0);
		let label = 0, bestLabel = 0, bestSize = 0;
		for (let start = 0; start < peak.length; start++) {
			if (labels[start] !== 0 || peak[start] <= threshold) continue;
			label++;
			let top = 0, size = 0;
			stack[top++] = start;
			labels[start] = label;
			while (top > 0) {
				const p = stack[--top];
				size++;
				const x = p % w, y = (p - x) / w;
				if (x > 0 && labels[p - 1] === 0 && peak[p - 1] > threshold) { labels[p - 1] = label; stack[top++] = p - 1; }
				if (x < w - 1 && labels[p + 1] === 0 && peak[p + 1] > threshold) { labels[p + 1] = label; stack[top++] = p + 1; }
				if (y > 0 && labels[p - w] === 0 && peak[p - w] > threshold) { labels[p - w] = label; stack[top++] = p - w; }
				if (y < h - 1 && labels[p + w] === 0 && peak[p + w] > threshold) { labels[p + w] = label; stack[top++] = p + w; }
			}
			if (size > bestSize) { bestSize = size; bestLabel = label; }
		}
		if (bestSize === 0) return null;
		const points = [];
		for (let y = 0; y < h; y++) {
			let lo = -1, hi = -1;
			for (let x = 0; x < w; x++) {
				if (labels[y * w + x] === bestLabel) { if (lo < 0) lo = x; hi = x; }
			}
			if (lo >= 0) { points.push([lo, y]); if (hi !== lo) points.push([hi, y]); }
		}
		return { size: bestSize, points };
	}

	// Best guess at the screen quad from the accumulated peak image, or null.
	detect(source = this.peak) {
		const { hist } = this;
		this.clipped = false;
		const peak = source;
		const total = peak.length;
		hist.fill(0);
		for (let i = 0; i < total; i++) hist[Math.min(255, peak[i] | 0)]++;
		const threshold = otsuThreshold(hist, total);
		const blob = this.largestComponent(threshold, peak);
		if (!blob) return null;
		if (blob.size < total * this.minAreaFrac || blob.size > total * this.maxAreaFrac) return null;
		const hull = convexHull(blob.points);
		if (hull.length < 4) return null;
		const quad = maxAreaQuad(simplifyPolygon(hull, 2, 4));
		if (!quad || !isConvex(quad)) return null;
		// Two shape checks, and they reject different impostors. A round lamp
		// has a perfectly solid blob but its hull is not a quadrilateral, so the
		// best quad inscribed in it loses a lot of area. A ring or an L-shaped
		// highlight has a quad-like hull but does not fill it.
		const hullArea = quadArea(hull);
		if (hullArea <= 0 || quadArea(quad) / hullArea < this.minHullFit) return null;
		if (blob.size / quadArea(quad) < this.minFill) return null;
		// And it has to be a screen, not just a quad-shaped patch of wall: what
		// makes it a screen is that it is brighter than the room around it. An
		// evenly lit view has no such step anywhere and must yield nothing.
		if (this.contrast(quad, peak) < this.minStep) return null;
		// Corners sitting on the edge of the image mean the screen runs off the
		// side of the view, and the quad is really the shape of the viewport.
		// Nothing here can say where the true corners are, so this is reported
		// rather than guessed at: the user can zoom out, and tracking will hold
		// the outline afterwards even when they zoom back in.
		const margin = 1.5;
		if (quad.some(([x, y]) => x < margin || y < margin || x > this.w - 1 - margin || y > this.h - 1 - margin)) {
			this.clipped = true;
			return null;
		}
		return quad;
	}

	// Detection on a single frame, ignoring the accumulated peak. Used as an
	// occasional sanity check while tracking, where waiting for a peak image to
	// build up is not an option.
	detectSingle(gray) {
		return this.detect(gray.data);
	}

	// Mean luminance inside the quad minus mean outside, on a coarse grid.
	contrast(quad, source) {
		const { w, h } = this;
		let inSum = 0, inCount = 0, outSum = 0, outCount = 0;
		for (let y = 0; y < h; y += 2) {
			for (let x = 0; x < w; x += 2) {
				const v = source[y * w + x];
				if (insideQuad(quad, x, y)) { inSum += v; inCount++; }
				else { outSum += v; outCount++; }
			}
		}
		if (inCount < 32 || outCount < 32) return Infinity;
		return inSum / inCount - outSum / outCount;
	}
}
