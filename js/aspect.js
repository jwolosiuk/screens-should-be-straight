// True width-to-height ratio of the real screen, recovered from its projection.
//
// A rectangle seen at an angle lands in the image as a quad whose apparent
// proportions are wrong, so un-warping to a fixed 16:9 box would stretch the
// picture whenever the real screen is not 16:9. The construction below is
// Zhang and He's (Whiteboard Scanning and Image Enhancement, 2007): the two
// vanishing points of the rectangle constrain both the camera's focal length
// and the aspect ratio.
//
// It degenerates when the view is nearly straight-on - there are no vanishing
// points left to measure - which is fine, because that is exactly the case
// where the quad's own proportions are already almost correct.

const cross = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Focal length in pixels implied by an assumed horizontal field of view.
export function focalFromFov(widthPx, fovDegrees = 65) {
	return widthPx / 2 / Math.tan((fovDegrees * Math.PI) / 360);
}

/**
 * @param {number[][]} quad corners as top-left, top-right, bottom-right, bottom-left
 * @returns {{aspect:number, focal:number|null, method:string}|null}
 */
export function estimateAspect(quad, opts = {}) {
	if (!quad || quad.length !== 4) return null;
	const [u0, v0] = opts.principal ?? [0, 0];
	const fallbackFocal = opts.focal ?? null;
	const min = opts.min ?? 0.25;
	const max = opts.max ?? 6;

	const m1 = [quad[0][0], quad[0][1], 1];
	const m2 = [quad[1][0], quad[1][1], 1];
	const m3 = [quad[3][0], quad[3][1], 1];
	const m4 = [quad[2][0], quad[2][1], 1];

	const d1 = dot(cross(m1, m4), m3);
	const d2 = dot(cross(m2, m4), m3);
	const d3 = dot(cross(m1, m4), m2);
	const d4 = dot(cross(m3, m4), m2);
	if (Math.abs(d2) < 1e-9 || Math.abs(d4) < 1e-9) return null;
	const k2 = d1 / d2;
	const k3 = d3 / d4;

	const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1];
	const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];

	// Both vanishing points at infinity: the view is fronto-parallel and the
	// quad is already a scaled rectangle.
	if (Math.abs(n2[2]) < 1e-6 && Math.abs(n3[2]) < 1e-6) {
		const a = Math.sqrt((n2[0] * n2[0] + n2[1] * n2[1]) / (n3[0] * n3[0] + n3[1] * n3[1]));
		if (!isFinite(a) || a <= 0) return null;
		return { aspect: clamp(a, min, max), clamped: a < min || a > max, focal: null, method: 'affine' };
	}

	let focal = null;
	let method = 'perspective';
	const denom = n2[2] * n3[2];
	if (Math.abs(denom) > 1e-9) {
		const fx = n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0;
		const fy = n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0;
		const f2 = -(fx + fy) / denom;
		if (f2 > 0 && isFinite(f2)) focal = Math.sqrt(f2);
	}
	if (focal === null) {
		if (!fallbackFocal) return null;
		focal = fallbackFocal;
		method = 'assumed-focal';
	}

	// |A^-1 n|^2 for A = [[f,0,u0],[0,f,v0],[0,0,1]].
	const norm = (n) => {
		const x = (n[0] - u0 * n[2]) / focal;
		const y = (n[1] - v0 * n[2]) / focal;
		return x * x + y * y + n[2] * n[2];
	};
	const denom3 = norm(n3);
	if (denom3 < 1e-12) return null;
	const aspect = Math.sqrt(norm(n2) / denom3);
	if (!isFinite(aspect) || aspect <= 0) return null;
	// A clamped answer is not a slightly-wrong answer, it is a failed one: the
	// construction has gone unstable and the caller should keep what it had.
	return { aspect: clamp(aspect, min, max), clamped: aspect < min || aspect > max, focal, method };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
