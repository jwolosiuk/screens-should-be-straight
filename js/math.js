// 3x3 matrices (row-major, 9-element arrays) and the four-point homography.
//
// A homography is what turns "screen seen from an angle" into "screen seen
// straight": it is the most general mapping between two views of the same
// plane. Solving it from four point pairs is the whole geometric core of this
// app; everything else just finds those four points every frame.

export function mat3Apply(H, x, y) {
	const w = H[6] * x + H[7] * y + H[8];
	if (w === 0) return null;
	return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function mat3Mul(A, B) {
	const C = new Array(9);
	for (let r = 0; r < 3; r++) {
		for (let c = 0; c < 3; c++) {
			C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
		}
	}
	return C;
}

export function mat3Invert(H) {
	const [a, b, c, d, e, f, g, h, i] = H;
	const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
	const s = 1 / det;
	return [
		A * s, (c * h - b * i) * s, (b * f - c * e) * s,
		B * s, (a * i - c * g) * s, (c * d - a * f) * s,
		C * s, (b * g - a * h) * s, (a * e - b * d) * s,
	];
}

// Gaussian elimination with partial pivoting. A is n*n row-major, b is n long.
export function solveLinear(A, b, n) {
	const M = Float64Array.from(A);
	const v = Float64Array.from(b);
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let row = col + 1; row < n; row++) {
			if (Math.abs(M[row * n + col]) > Math.abs(M[pivot * n + col])) pivot = row;
		}
		if (Math.abs(M[pivot * n + col]) < 1e-12) return null;
		if (pivot !== col) {
			for (let k = 0; k < n; k++) {
				const t = M[col * n + k]; M[col * n + k] = M[pivot * n + k]; M[pivot * n + k] = t;
			}
			const t = v[col]; v[col] = v[pivot]; v[pivot] = t;
		}
		const p = M[col * n + col];
		for (let row = col + 1; row < n; row++) {
			const factor = M[row * n + col] / p;
			if (factor === 0) continue;
			for (let k = col; k < n; k++) M[row * n + k] -= factor * M[col * n + k];
			v[row] -= factor * v[col];
		}
	}
	const x = new Array(n);
	for (let row = n - 1; row >= 0; row--) {
		let sum = v[row];
		for (let k = row + 1; k < n; k++) sum -= M[row * n + k] * x[k];
		x[row] = sum / M[row * n + row];
	}
	return x.every(Number.isFinite) ? x : null;
}

// Homography mapping the four src points onto the four dst points, normalised
// so that h33 = 1. Returns null when the points are degenerate (collinear or
// coincident), which happens for a moment whenever tracking goes wrong.
export function solveHomography(src, dst) {
	if (src.length !== 4 || dst.length !== 4) return null;
	const A = new Float64Array(64);
	const b = new Float64Array(8);
	for (let i = 0; i < 4; i++) {
		const [x, y] = src[i];
		const [u, v] = dst[i];
		const r0 = i * 2 * 8, r1 = (i * 2 + 1) * 8;
		A[r0] = x; A[r0 + 1] = y; A[r0 + 2] = 1; A[r0 + 6] = -u * x; A[r0 + 7] = -u * y;
		A[r1 + 3] = x; A[r1 + 4] = y; A[r1 + 5] = 1; A[r1 + 6] = -v * x; A[r1 + 7] = -v * y;
		b[i * 2] = u; b[i * 2 + 1] = v;
	}
	const h = solveLinear(A, b, 8);
	if (!h) return null;
	return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export const UNIT_SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1]];
