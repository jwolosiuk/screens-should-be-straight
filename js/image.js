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
	return rgbaToChannels(rgba, w, h, { light: out }).light;
}

// Both channels in one pass. `light` is the boosted measure above, for finding
// and tracking the screen. `plain` is the bare largest channel, and it is what
// change is measured on: the boost pushes a bright picture against the top of
// the byte, and differences taken up there come back crushed - a film can
// change plenty and register almost nothing. The bare channel has headroom.
export function rgbaToChannels(rgba, w, h, out = {}) {
	out.light ??= makeGray(w, h);
	out.plain ??= makeGray(w, h);
	const lightD = out.light.data, plainD = out.plain.data;
	for (let i = 0, p = 0; i < lightD.length; i++, p += 4) {
		const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
		const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
		const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
		plainD[i] = max;
		lightD[i] = max + (max - min) * 0.5;
	}
	return out;
}

// Per-pixel absolute difference between two frames of the same size. This is
// the raw form of the change channel; ChangeTracker below is what callers
// should use, because a raw difference is only meaningful from a tripod.
export function diffGray(a, b, out = makeGray(a.w, a.h)) {
	const d = out.data;
	for (let i = 0; i < d.length; i++) {
		const delta = a.data[i] - b.data[i];
		d[i] = delta < 0 ? -delta : delta;
	}
	return out;
}

// Global translation between two frames, to subpixel precision, by SAD search
// over a sparse grid: a coarse pass at even offsets, a fine pass around the
// winner, then a parabolic fit. Hand shake is overwhelmingly translation at
// this scale, so one (dx, dy) per frame is what it takes to stop static
// furniture from lighting up the change map.
export function estimateShift(cur, ref, maxShift = 7) {
	const { w, h } = cur;
	const margin = maxShift + 1;
	// Capped per-pixel loss, and the cap is what makes this robust: a region
	// that matches NO shift - a playing film, a person sweeping across the
	// view - contributes the same constant everywhere and stops voting, so the
	// static majority decides. With a plain mean, a film covering most of the
	// frame dragged the "camera motion" to wherever its content was panning.
	const CAP = 24;
	const sadAt = (dx, dy, step) => {
		let sum = 0, n = 0;
		for (let y = margin; y < h - margin; y += step) {
			for (let x = margin; x < w - margin; x += step) {
				let d = cur.data[y * w + x] - ref.data[(y + dy) * w + (x + dx)];
				if (d < 0) d = -d;
				sum += d > CAP ? CAP : d;
				n++;
			}
		}
		return sum / n;
	};
	let best = { dx: 0, dy: 0, sad: Infinity };
	for (let dy = -maxShift + 1; dy <= maxShift - 1; dy += 2) {
		for (let dx = -maxShift + 1; dx <= maxShift - 1; dx += 2) {
			const sad = sadAt(dx, dy, 8);
			if (sad < best.sad) best = { dx, dy, sad };
		}
	}
	const fine = new Map();
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			const px = best.dx + dx, py = best.dy + dy;
			if (Math.abs(px) > maxShift || Math.abs(py) > maxShift) continue;
			fine.set(`${dx},${dy}`, sadAt(px, py, 4));
		}
	}
	let centre = { dx: 0, dy: 0, sad: Infinity };
	for (const [key, sad] of fine) {
		if (sad < centre.sad) {
			const [dx, dy] = key.split(',').map(Number);
			centre = { dx, dy, sad };
		}
	}
	const ix = best.dx + centre.dx, iy = best.dy + centre.dy;
	// Parabolic subpixel refinement along each axis where neighbours exist.
	const sub = (m, p, c) => {
		if (m === undefined || p === undefined) return 0;
		const denom = m - 2 * c + p;
		return Math.abs(denom) > 1e-9 ? Math.max(-1, Math.min(1, 0.5 * (m - p) / denom)) : 0;
	};
	const at = (dx, dy) => fine.get(`${dx - best.dx},${dy - best.dy}`);
	return {
		dx: ix + sub(at(ix - 1, iy), at(ix + 1, iy), centre.sad),
		dy: iy + sub(at(ix, iy - 1), at(ix, iy + 1), centre.sad),
		saturated: Math.abs(ix) >= maxShift - 1 || Math.abs(iy) >= maxShift - 1,
		// The residual at the best match. A static scene matches some shift
		// almost perfectly, so this sits at the noise floor; content that
		// plays cannot be matched by any shift and leaves it high. That makes
		// it a motion-proof "is something playing" scalar, useful exactly when
		// the change map itself cannot be formed.
		sad: centre.sad,
	};
}

// The change channel done properly: each frame is compared against a reference
// from a few tenths of a second ago, WARPED by the estimated camera motion, so
// that only things that changed on their own - a playing film - survive the
// difference. Without the warp, hand tremor lights up every static edge in the
// room with ghosts of itself, and the film drowns in them; that is not a
// corner case, it is what a phone in a hand does all the time.
//
// Frames the comparison cannot be trusted on come back as null: motion beyond
// the search window (a pan - the reference is simply restarted), and global
// events where most of the frame changed at once (an auto-exposure or white
// balance ramp - nothing moved, everything got brighter, and folding that into
// any memory would poison it).
export class ChangeTracker {
	constructor(w, h, opts = {}) {
		this.w = w;
		this.h = h;
		this.refreshEvery = opts.refreshEvery ?? 12;
		this.maxShift = opts.maxShift ?? 7;
		this.globalLimit = opts.globalLimit ?? 12;
		this.reference = makeGray(w, h);
		this.change = makeGray(w, h);
		this.previous = makeGray(w, h);
		this.sinceRefresh = -1;
		this.restlessness = 0;
	}

	// The 10th percentile of the change map over a sparse grid. An exposure or
	// white-balance ramp moves everything at once, quietest corners included,
	// so this comes back high. A screen - even one filling most of the view -
	// leaves a sliver of room around itself that holds the low percentile
	// down. The percentile has to sit below any plausible screen coverage: at
	// the median, a film covering half the frame read as an exposure event and
	// the tracker went blind exactly when the user stood close.
	globalLevel() {
		const values = [];
		const { data, w, h } = this.change;
		for (let y = 4; y < h; y += 8) {
			for (let x = 4; x < w; x += 8) values.push(data[y * w + x]);
		}
		values.sort((a, b) => a - b);
		return values[Math.floor(values.length * 0.1)];
	}

	restart(plain) {
		this.reference.data.set(plain.data);
		this.sinceRefresh = 0;
	}

	// An exposure or gain ramp changes every pixel in PROPORTION to its
	// brightness - which is why an absolute threshold misses slow ramps: the
	// dark bezel moves by less than any sane floor while the bright wall
	// sails past it, and the ramp walks straight into every memory. The
	// signature is the ratio: change divided by brightness is large AND
	// nearly uniform across the frame. A film's ratio is large only where the
	// film is, and wildly non-uniform.
	looksLikeGainRamp(plain) {
		const ratios = [];
		const { data, w, h } = this.change;
		for (let y = 4; y < h; y += 8) {
			for (let x = 4; x < w; x += 8) {
				const i = y * w + x;
				if (plain.data[i] > 40) ratios.push(data[i] / plain.data[i]);
			}
		}
		if (ratios.length < 40) return false;
		ratios.sort((a, b) => a - b);
		const median = ratios[ratios.length >> 1];
		const spread = ratios[Math.floor(ratios.length * 0.75)] - ratios[Math.floor(ratios.length * 0.25)];
		return median >= 0.03 && spread <= Math.max(0.04, 0.8 * median);
	}

	diffAgainstReference(plain, dx, dy) {
		const { data, w, h } = plain;
		const out = this.change.data;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const value = dx === 0 && dy === 0
					? this.reference.data[y * w + x]
					: bilinear(this.reference, x + dx, y + dy);
				const i = y * w + x;
				out[i] = value < 0 ? 0 : Math.abs(data[i] - value);
			}
		}
	}

	/**
	 * @param {{data:Uint8ClampedArray,w:number,h:number}} plain current frame
	 * @returns {{change:object|null, motion:number}} change against the
	 *   motion-compensated reference (null when untrustworthy), and the
	 *   camera's own frame-to-frame motion in pixels.
	 *
	 * Two motion estimates, and the difference between them matters. The
	 * frame-to-frame one is the camera's real motion: at one frame's distance
	 * a hand cannot outrun the search window, so it is trustworthy always.
	 * The against-the-reference one is only a warp parameter - and when most
	 * of the view is a film whose content pans, the film drags it to the
	 * window edge while the camera sits perfectly still. Reference saturation
	 * with a quiet camera means exactly that, and the honest answer is to
	 * compare unwarped; saturation with a moving camera is a pan, and the
	 * honest answer is no answer.
	 */
	push(plain) {
		if (this.sinceRefresh < 0) {
			this.restart(plain);
			this.previous.data.set(plain.data);
			this.restlessness = 0;
			return { change: null, motion: 0 };
		}
		const frameShift = estimateShift(plain, this.previous, this.maxShift);
		this.previous.data.set(plain.data);
		this.restlessness = frameShift.sad;
		// A saturated shift can mean two opposite things. A pan matches its own
		// displacement - just outside the window - so the residual stays low. A
		// shot cut matches nothing anywhere, the argmin lands wherever, and the
		// residual is high; the camera did not move at all, and treating the
		// cut as a pan would throw away exactly the frames that carry a film's
		// loudest evidence.
		const cut = frameShift.saturated && frameShift.sad >= 8;
		const motion = frameShift.saturated
			? (cut ? 0 : this.maxShift)
			: Math.hypot(frameShift.dx, frameShift.dy);

		const refShift = estimateShift(plain, this.reference, this.maxShift);
		if (refShift.saturated && motion >= 1.5) {
			// A pan: too far from the reference to compare, and really moving.
			this.restart(plain);
			return { change: null, motion };
		}
		if (refShift.saturated) this.diffAgainstReference(plain, 0, 0);
		else this.diffAgainstReference(plain, refShift.dx, refShift.dy);

		if (this.globalLevel() >= this.globalLimit || this.looksLikeGainRamp(plain)) {
			// Exposure or white balance moved the whole frame at once.
			this.restart(plain);
			return { change: null, motion };
		}
		if (++this.sinceRefresh >= this.refreshEvery) this.restart(plain);
		return { change: this.change, motion };
	}
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

