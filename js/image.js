// Grayscale buffers. A "gray" is { data: Uint8ClampedArray|Float32Array, w, h }
// holding one luminance byte per pixel. Detection and tracking both work on a
// small copy of the camera frame (a few hundred pixels wide) while rendering
// still uses the full-resolution video, so the heavy per-pixel passes stay
// cheap on a phone.

export function makeGray(w, h) {
	return { data: new Uint8ClampedArray(w * h), w, h };
}

// How much light is coming off a surface, and how much of it is projector.
//
// Two departures from ordinary luminance, both learned from a real outdoor
// screening. First, brightness is the largest colour channel rather than a
// weighted mix: projected film often sits on a single saturated hue for
// minutes at a time, and saturated colours carry little luminance - a deep red
// picture at (190, 12, 26) computes to a luma of 62, dimmer than the plain
// grey of the unlit screen around it at 72. Detection built on luma puts the
// edge of the screen in the wrong place there, or loses it entirely.
//
// Second, saturation counts for something. An inflatable screen is larger than
// the picture thrown onto it, leaving grey margins that are brighter than the
// night sky behind them - a perfectly good edge, in the wrong place, a few
// pixels outside the one that matters. Grey is what ambient light looks like;
// colour is what a projector looks like. Adding half the chroma separates them
// while leaving a black-and-white film, which has brightness to spare,
// untouched.
export function rgbaToScreenLight(rgba, w, h, out = makeGray(w, h)) {
	const d = out.data;
	for (let i = 0, p = 0; i < d.length; i++, p += 4) {
		const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
		const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
		const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
		d[i] = max + (max - min) * 0.5;
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

