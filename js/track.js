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
//
// The outline is then solved for, not intersected. Four visible edges give
// four lines and eight equations for the eight corner coordinates, which is
// exactly the old intersection. But zoom in, or let a person stand in front of
// the screen, and some of those edges are simply not there - so the equations
// that remain are solved together with a weak pull towards where the motion so
// far says the corners should be. Whatever the evidence pins down, it pins
// down; whatever it leaves free comes from the prediction.

import { fitLineRobust, inwardNormal, isConvex, signedArea } from './geom.js';
import { bilinear } from './image.js';
import { solveLinear } from './math.js';

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
 * Fit one edge of the outline against the frame.
 * @returns {{line:{a:number,b:number,c:number}, inliers:number, usable:number}|null}
 */
export function measureEdge(gray, quad, edge, opts = {}) {
	const samples = opts.samples ?? 20;
	const radius = opts.radius ?? defaultRadius(gray);
	const minContrast = opts.minContrast ?? 16;
	const minStep = opts.minStep ?? 25;
	const minInliers = opts.minInliers ?? 6;
	const minSupport = opts.minSupport ?? 0.35;

	const p0 = quad[edge], p1 = quad[(edge + 1) % 4];
	const [nx, ny] = inwardNormal(quad, edge);
	const points = [];
	let usable = 0;
	for (let j = 0; j < samples; j++) {
		// Skip the last tenth at each end: corners are rounded and often
		// occluded, and a bad sample there pulls the whole line.
		const t = 0.1 + 0.8 * ((j + 0.5) / samples);
		const px = p0[0] + (p1[0] - p0[0]) * t;
		const py = p0[1] + (p1[1] - p0[1]) * t;
		// An edge that runs off the side of the view is not a failed
		// measurement, it is a shorter one: only the part in view can vote, and
		// the threshold is a fraction of what could have voted.
		if (bilinear(gray, px, py) < 0) continue;
		usable++;
		const s = findStep(gray, px, py, nx, ny, radius, minContrast, minStep);
		if (s !== null) points.push([px + nx * s, py + ny * s]);
	}
	if (usable < minInliers) return null;
	const needed = Math.max(minInliers, Math.ceil(minSupport * usable));
	if (points.length < needed) return null;
	const fit = fitLineRobust(points, { minInliers: needed });
	return fit ? { line: fit.line, inliers: fit.inliers.length, usable } : null;
}

/**
 * Corner positions that best satisfy the measured edges, pulled gently towards
 * `prior` wherever the measurements leave a degree of freedom free.
 *
 * With four edges measured the line equations alone determine all eight
 * unknowns and the prior changes the answer by a fraction of a pixel. With
 * one or two, it is the prior that supplies the rest - which is the difference
 * between coasting through an obstruction and losing the screen.
 */
export function solveCorners(lines, prior, priorWeight = 0.05) {
	const AtA = new Float64Array(64);
	const Atb = new Float64Array(8);
	const addRow = (row, value) => {
		for (let i = 0; i < 8; i++) {
			if (row[i] === 0) continue;
			Atb[i] += row[i] * value;
			for (let j = 0; j < 8; j++) {
				if (row[j] !== 0) AtA[i * 8 + j] += row[i] * row[j];
			}
		}
	};
	const row = new Float64Array(8);
	lines.forEach((line, e) => {
		if (!line) return;
		// Both corners of this edge lie on the measured line: a*x + b*y + c = 0.
		for (const corner of [e, (e + 1) % 4]) {
			row.fill(0);
			row[corner * 2] = line.a;
			row[corner * 2 + 1] = line.b;
			addRow(row, -line.c);
		}
	});
	for (let corner = 0; corner < 4; corner++) {
		for (let axis = 0; axis < 2; axis++) {
			row.fill(0);
			row[corner * 2 + axis] = priorWeight;
			addRow(row, priorWeight * prior[corner][axis]);
		}
	}
	const solution = solveLinear(AtA, Atb, 8);
	if (!solution) return null;
	return [0, 1, 2, 3].map((i) => [solution[i * 2], solution[i * 2 + 1]]);
}

/**
 * Refine `prevQuad` against the current frame. `prevQuad` doubles as the prior,
 * so callers should pass where they expect the outline to be, not where it was.
 * @returns {{quad, confidence, edges, seen}|null}
 */
export function trackQuad(gray, prevQuad, opts = {}) {
	const lines = [];
	let inlierTotal = 0, usableTotal = 0, seen = 0;
	for (let e = 0; e < 4; e++) {
		const measured = measureEdge(gray, prevQuad, e, opts);
		lines.push(measured ? measured.line : null);
		if (measured) {
			seen++;
			inlierTotal += measured.inliers;
			usableTotal += measured.usable;
		}
	}
	const quad = solveCorners(lines, prevQuad, opts.priorWeight ?? 0.05);
	if (!quad) return null;
	// Convex is not enough: the solve can hand back a quad wound the other way,
	// and every "inward" decision downstream would then point out of the screen.
	if (!isConvex(quad) || signedArea(quad) <= 0) return null;
	return {
		quad,
		edges: seen,
		confidence: usableTotal ? (inlierTotal / usableTotal) * (seen / 4) : 0,
		seen: lines.map(Boolean),
	};
}
