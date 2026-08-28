// Grayscale buffers. A "gray" is { data: Uint8ClampedArray|Float32Array, w, h }
// holding one luminance byte per pixel. Detection and tracking both work on a
// small copy of the camera frame (a few hundred pixels wide) while rendering
// still uses the full-resolution video, so the heavy per-pixel passes stay
// cheap on a phone.

export function makeGray(w, h) {
	return { data: new Uint8ClampedArray(w * h), w, h };
}

// Rec. 601 luma, integer-only, from RGBA pixels as produced by getImageData.
export function rgbaToGray(rgba, w, h, out = makeGray(w, h)) {
	const d = out.data;
	for (let i = 0, p = 0; i < d.length; i++, p += 4) {
		d[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
	}
	return out;
}

export function bilinear(gray, x, y) {
	const { data, w, h } = gray;
	if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return -1;
	const x0 = Math.floor(x), y0 = Math.floor(y);
	const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
	const fx = x - x0, fy = y - y0;
	const a = data[y0 * w + x0], b = data[y0 * w + x1];
	const c = data[y1 * w + x0], d = data[y1 * w + x1];
	return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

export function scaleQuad(quad, sx, sy) {
	return quad.map(([x, y]) => [x * sx, y * sy]);
}
