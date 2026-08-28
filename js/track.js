// Frame-to-frame tracking of the screen outline.
//
// This is the part that makes a hand-held camera work. Re-running acquisition
// every frame would be both slow and fragile (a dark scene erases the blob),
// so instead each frame refines the previous outline: walk along each of the
// four edges, and at every sample point look sideways for the luminance step
// that marks the border of the screen.
//
// The step has a known polarity - outside is dark room, inside is lit picture,
// so luminance rises along the inward normal. Testing for that sign is what
// keeps the edge glued to the bezel instead of snapping onto some high
// contrast edge inside the movie itself, which is the failure mode that makes
// naive edge tracking jitter.

import { fitLineRobust, inwardNormal, isConvex, lineIntersect, signedArea } from './geom.js';
import { bilinear } from './image.js';

const lineThrough = (p0, p1) => {
	const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
	const len = Math.hypot(dx, dy) || 1;
	const a = -dy / len, b = dx / len;
	return { a, b, c: -(a * p0[0] + b * p0[1]) };
};

// Average luminance a few pixels outside a candidate border, subtracted from
// the average a few pixels inside it. Null when too much of the window falls
// outside the image to judge.
function stepAcross(gray, px, py, nx, ny, s, near, far) {
	let outSum = 0, outCount = 0, inSum = 0, inCount = 0;
	for (let k = near; k <= far; k++) {
		const outer = bilinear(gray, px + nx * (s - k), py + ny * (s - k));
		const inner = bilinear(gray, px + nx * (s + k), py + ny * (s + k));
		if (outer >= 0) { outSum += outer; outCount++; }
		if (inner >= 0) { inSum += inner; inCount++; }
	}
	if (outCount < 3 || inCount < 3) return null;
	return inSum / inCount - outSum / outCount;
}

// The border of the screen, somewhere along the inward normal from a sample
// point, as an offset in pixels - or null if nothing convincing is there.
//
// Two rules, and the app depends on both. First, take the *outermost*
// candidate, not the strongest: a cut to a bright shot beside a dark one
// out-contrasts the edge of the screen itself, and the screen border is always
// the outer one. Second, judge a candidate on what lies either side of it over
// several pixels, not on the local gradient: room on the outside, lit picture
// on the inside. An edge within the film has picture on both sides and fails
// that test however sharp it is - which matters because the vertical edges in
// a film are exactly parallel to the sides of the screen, so a whole row of
// samples can agree on the wrong line and out-vote the right one.
function findStep(gray, px, py, nx, ny, radius, minContrast, minStep) {
	const n = 2 * radius + 1;
	const grad = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const s = i - radius;
		const before = bilinear(gray, px + nx * (s - 1), py + ny * (s - 1));
		const after = bilinear(gray, px + nx * (s + 1), py + ny * (s + 1));
		grad[i] = before < 0 || after < 0 ? -Infinity : after - before;
	}
	for (let i = 0; i < n; i++) {
		if (!(grad[i] >= minContrast)) continue;
		if (i > 0 && grad[i] < grad[i - 1]) continue;
		if (i < n - 1 && grad[i] < grad[i + 1]) continue;
		const s = i - radius;
		const step = stepAcross(gray, px, py, nx, ny, s, 2, 7);
		if (step === null || step < minStep) continue;
		let offset = 0;
		if (i > 0 && i < n - 1 && isFinite(grad[i - 1]) && isFinite(grad[i + 1])) {
			const denom = grad[i - 1] - 2 * grad[i] + grad[i + 1];
			if (Math.abs(denom) > 1e-6) {
				offset = Math.max(-1, Math.min(1, 0.5 * (grad[i - 1] - grad[i + 1]) / denom));
			}
		}
		return s + offset;
	}
	return null;
}

export function defaultRadius(gray) {
	return Math.max(5, Math.round(0.055 * Math.max(gray.w, gray.h)));
}

/**
 * Refine `prevQuad` against the current frame.
 * Returns { quad, confidence, weakEdges } or null when the lock is lost.
 */
export function trackQuad(gray, prevQuad, opts = {}) {
	const samples = opts.samples ?? 20;
	const radius = opts.radius ?? defaultRadius(gray);
	const minContrast = opts.minContrast ?? 16;
	const minStep = opts.minStep ?? 25;
	const minInliers = opts.minInliers ?? 6;
	const maxWeakEdges = opts.maxWeakEdges ?? 1;

	const lines = [];
	let weakEdges = 0;
	let inlierTotal = 0;
	for (let e = 0; e < 4; e++) {
		const p0 = prevQuad[e], p1 = prevQuad[(e + 1) % 4];
		const [nx, ny] = inwardNormal(prevQuad, e);
		const points = [];
		for (let j = 0; j < samples; j++) {
			// Skip the last tenth at each end: corners are rounded and often
			// occluded, and a bad sample there pulls the whole line.
			const t = 0.1 + 0.8 * ((j + 0.5) / samples);
			const px = p0[0] + (p1[0] - p0[0]) * t;
			const py = p0[1] + (p1[1] - p0[1]) * t;
			const s = findStep(gray, px, py, nx, ny, radius, minContrast, minStep);
			if (s !== null) points.push([px + nx * s, py + ny * s]);
		}
		const fit = points.length >= minInliers ? fitLineRobust(points, { minInliers }) : null;
		if (fit) {
			lines.push(fit.line);
			inlierTotal += fit.inliers.length;
		} else {
			// Edge ran out of the frame, or is lying against something just as
			// bright. Carry the previous edge for one or two frames rather than
			// dropping the lock outright; more than one such edge and the
			// outline is no longer trustworthy.
			weakEdges++;
			if (weakEdges > maxWeakEdges) return null;
			lines.push(lineThrough(p0, p1));
		}
	}

	const quad = [];
	for (let i = 0; i < 4; i++) {
		const corner = lineIntersect(lines[(i + 3) % 4], lines[i]);
		if (!corner) return null;
		quad.push(corner);
	}
	// Convex is not enough: intersecting edge lines can hand back a quad wound
	// the other way, and every "inward" decision downstream would then point
	// out of the screen.
	if (!isConvex(quad) || signedArea(quad) <= 0) return null;
	return { quad, confidence: inlierTotal / (samples * 4), weakEdges };
}
