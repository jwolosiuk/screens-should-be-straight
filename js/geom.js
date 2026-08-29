// Quadrilateral and line geometry.
//
// Convention: image coordinates, x right and y down. A quad is an array of
// four [x, y] corners in the order top-left, top-right, bottom-right,
// bottom-left, which under y-down axes has a positive shoelace area. Keeping
// that orientation fixed is what lets the tracker say "inward" without
// re-deriving it, so every function here either preserves it or restores it.

export function signedArea(quad) {
	let s = 0;
	for (let i = 0; i < quad.length; i++) {
		const [x0, y0] = quad[i];
		const [x1, y1] = quad[(i + 1) % quad.length];
		s += x0 * y1 - x1 * y0;
	}
	return s / 2;
}

export const quadArea = (quad) => Math.abs(signedArea(quad));

export function isConvex(quad) {
	let sign = 0;
	for (let i = 0; i < quad.length; i++) {
		const a = quad[i], b = quad[(i + 1) % quad.length], c = quad[(i + 2) % quad.length];
		const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
		if (Math.abs(cross) < 1e-9) continue;
		const s = Math.sign(cross);
		if (sign === 0) sign = s;
		else if (s !== sign) return false;
	}
	return sign !== 0;
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Corners in canonical order. Sorting by angle around the centroid gives a
// convex ring; the rotation then puts the top-left-most corner first.
export function orderQuad(points) {
	const pts = points.map((p) => [p[0], p[1]]);
	const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
	const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
	pts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
	let start = 0;
	for (let i = 1; i < pts.length; i++) {
		if (pts[i][0] + pts[i][1] < pts[start][0] + pts[start][1]) start = i;
	}
	const out = [];
	for (let i = 0; i < pts.length; i++) out.push(pts[(start + i) % pts.length]);
	return signedArea(out) < 0 ? [out[0], ...out.slice(1).reverse()] : out;
}

// Andrew's monotone chain, counter-clockwise in y-up terms.
export function convexHull(points) {
	if (points.length < 3) return points.map((p) => [p[0], p[1]]);
	const pts = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const build = (src) => {
		const stack = [];
		for (const p of src) {
			while (stack.length >= 2 && cross(stack[stack.length - 2], stack[stack.length - 1], p) <= 0) stack.pop();
			stack.push(p);
		}
		stack.pop();
		return stack;
	};
	return [...build(pts), ...build(pts.slice().reverse())];
}

// Visvalingam-style thinning of a closed polygon: repeatedly drop the vertex
// whose removal changes the area least. Pixel-stepped hulls are full of
// one-pixel staircase vertices and this clears them out cheaply.
export function simplifyPolygon(poly, minArea = 2, keepAtLeast = 4) {
	let ring = poly.map((p) => [p[0], p[1]]);
	while (ring.length > keepAtLeast) {
		let best = -1, bestCost = Infinity;
		for (let i = 0; i < ring.length; i++) {
			const a = ring[(i - 1 + ring.length) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
			const cost = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
			if (cost < bestCost) { bestCost = cost; best = i; }
		}
		if (bestCost > minArea) break;
		ring.splice(best, 1);
	}
	return ring;
}

// Largest-area quadrilateral inscribed in a convex polygon. For each diagonal
// (i, k) take the best vertex on either side; O(n^3) on a polygon already
// thinned to a handful of vertices.
export function maxAreaQuad(poly) {
	if (poly.length < 4) return null;
	if (poly.length === 4) return orderQuad(poly);
	const n = poly.length;
	const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
	let best = null, bestArea = -1;
	for (let i = 0; i < n; i++) {
		for (let k = i + 2; k < n; k++) {
			let j = -1, jArea = -1;
			for (let t = i + 1; t < k; t++) {
				const a = tri(poly[i], poly[t], poly[k]);
				if (a > jArea) { jArea = a; j = t; }
			}
			let l = -1, lArea = -1;
			for (let t = k + 1; t < i + n; t++) {
				const a = tri(poly[i], poly[k], poly[t % n]);
				if (a > lArea) { lArea = a; l = t % n; }
			}
			if (j < 0 || l < 0) continue;
			if (jArea + lArea > bestArea) { bestArea = jArea + lArea; best = [poly[i], poly[j], poly[k], poly[l]]; }
		}
	}
	return best ? orderQuad(best) : null;
}

// Total least squares line through points, as a*x + b*y + c = 0 with a^2+b^2=1.
// Least squares on y given x would blow up on the vertical edges of a screen,
// hence the eigenvector form.
export function fitLine(points) {
	const n = points.length;
	if (n < 2) return null;
	let mx = 0, my = 0;
	for (const p of points) { mx += p[0]; my += p[1]; }
	mx /= n; my /= n;
	let sxx = 0, syy = 0, sxy = 0;
	for (const p of points) {
		const dx = p[0] - mx, dy = p[1] - my;
		sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
	}
	// Smallest-eigenvalue eigenvector of the scatter matrix is the line normal.
	const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
	const a = -Math.sin(theta), b = Math.cos(theta);
	return { a, b, c: -(a * mx + b * my) };
}

// Line fit that shrugs off outliers: bright content inside the picture, a hand
// over the bezel, a reflection. A least-squares fit bends towards whichever
// stray points are furthest out, so the consensus set is chosen first - every
// pair of samples proposes a line, the line with the most support wins - and
// only then is a proper fit run on the survivors.
export function fitLineRobust(points, { minInliers = 5, tolerance = 1.5 } = {}) {
	const n = points.length;
	if (n < minInliers) return null;
	const inlierCount = (line) => {
		let c = 0;
		for (const p of points) {
			if (Math.abs(line.a * p[0] + line.b * p[1] + line.c) <= tolerance) c++;
		}
		return c;
	};
	const through = (p, q) => {
		const dx = q[0] - p[0], dy = q[1] - p[1];
		const len = Math.hypot(dx, dy);
		if (len < 1e-6) return null;
		const a = -dy / len, b = dx / len;
		return { a, b, c: -(a * p[0] + b * p[1]) };
	};

	// Pairs too close together give a wildly uncertain direction, so require
	// some baseline between them.
	let spread = 0;
	for (let i = 1; i < n; i++) spread = Math.max(spread, dist(points[0], points[i]));
	const minSeparation = Math.max(1e-3, 0.3 * spread);
	const step = n > 40 ? Math.ceil(n / 40) : 1;

	let best = null, bestCount = 0;
	for (let i = 0; i < n; i += step) {
		for (let j = i + 1; j < n; j += step) {
			if (dist(points[i], points[j]) < minSeparation) continue;
			const line = through(points[i], points[j]);
			if (!line) continue;
			const count = inlierCount(line);
			if (count > bestCount) { bestCount = count; best = line; }
		}
	}
	if (!best || bestCount < minInliers) return null;

	let line = best;
	let inliers = points;
	for (let iter = 0; iter < 3; iter++) {
		const kept = points.filter((p) => Math.abs(line.a * p[0] + line.b * p[1] + line.c) <= tolerance);
		if (kept.length < minInliers) break;
		const refit = fitLine(kept);
		if (!refit) break;
		inliers = kept;
		line = refit;
	}
	return { line, inliers };
}

export function lineIntersect(l1, l2) {
	const det = l1.a * l2.b - l2.a * l1.b;
	if (Math.abs(det) < 1e-9) return null;
	return [(l1.b * l2.c - l2.b * l1.c) / det, (l2.a * l1.c - l1.a * l2.c) / det];
}

// Inward unit normal of edge i of a canonically ordered quad.
export function inwardNormal(quad, i) {
	const [x0, y0] = quad[i], [x1, y1] = quad[(i + 1) % 4];
	const dx = x1 - x0, dy = y1 - y0;
	const len = Math.hypot(dx, dy) || 1;
	return [-dy / len, dx / len];
}

export const quadsClose = (a, b, tol) => a.every((p, i) => dist(p, b[i]) <= tol);

// The similarity (scale, rotation, translation) that best carries one point
// set onto another, in closed form. Two points determine it exactly; more are
// least-squares. Used to extrapolate the corners the tracker cannot see from
// the ones it can: one camera moves everything together, so a transform
// fitted to the pinned corners is honest evidence about the free ones.
export function similarityBetween(from, to) {
	const n = from.length;
	if (n < 2) return null;
	let fx = 0, fy = 0, tx = 0, ty = 0;
	for (let i = 0; i < n; i++) {
		fx += from[i][0]; fy += from[i][1];
		tx += to[i][0]; ty += to[i][1];
	}
	fx /= n; fy /= n; tx /= n; ty /= n;
	let dot = 0, cross = 0, norm = 0;
	for (let i = 0; i < n; i++) {
		const px = from[i][0] - fx, py = from[i][1] - fy;
		const qx = to[i][0] - tx, qy = to[i][1] - ty;
		dot += px * qx + py * qy;
		cross += px * qy - py * qx;
		norm += px * px + py * py;
	}
	if (norm < 1e-9) return null;
	return { k: dot / norm, l: cross / norm, cx: fx, cy: fy, tx: tx - fx, ty: ty - fy };
}

export function applySimilarityPoint(sim, [x, y]) {
	const dx = x - sim.cx, dy = y - sim.cy;
	return [sim.k * dx - sim.l * dy + sim.cx + sim.tx, sim.l * dx + sim.k * dy + sim.cy + sim.ty];
}
