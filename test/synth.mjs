// Synthetic camera frames: a lit screen showing changing content, seen at an
// angle inside a dark room. Everything here is deterministic so a failing test
// fails the same way twice.

import { mat3Apply, mat3Invert, solveHomography, UNIT_SQUARE } from '../js/math.js';
import { orderQuad } from '../js/geom.js';

export function prng(seed = 1) {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

// A frame of "movie": bright, with structure of its own, changing from frame
// to frame. The internal contrast is the thing a naive edge tracker would latch
// onto by mistake.
export function moviePixel(u, v, t) {
	const bar = Math.abs(((u * 3 + t * 0.07) % 1) - 0.5) < 0.12 ? 70 : 0;
	const blob = Math.hypot(u - (0.5 + 0.3 * Math.sin(t * 0.1)), v - 0.5) < 0.18 ? 60 : 0;
	return Math.max(0, Math.min(255, 120 + bar + blob + 30 * Math.sin(u * 9 + t * 0.2)));
}

export const darkPixel = () => 12;

// Letterboxed content: black bands top and bottom. Against a dark room those
// bands have no contrast with the wall behind them, so what the app can see -
// and what it locks onto - is the lit picture, not the physical panel.
export const LETTERBOX = 0.1;
export const letterboxPixel = (u, v, t) => (v < LETTERBOX || v > 1 - LETTERBOX ? 6 : moviePixel(u, v, t));

// The sub-rectangle [0,1] x [v0,v1] of a screen quad, in image coordinates.
export function subQuad(quad, v0, v1) {
	const H = solveHomography(UNIT_SQUARE, quad);
	return [[0, v0], [1, v0], [1, v1], [0, v1]].map(([u, v]) => mat3Apply(H, u, v));
}

/**
 * Render one frame.
 * @returns {{data:Uint8ClampedArray, w:number, h:number}}
 */
export function renderScene({ w, h, quad, t = 0, content = moviePixel, room = 26, noise = 3, seed = 7 }) {
	const data = new Uint8ClampedArray(w * h);
	const H = solveHomography(UNIT_SQUARE, quad);
	const Hinv = mat3Invert(H);
	if (!Hinv) throw new Error('degenerate quad');
	const rand = prng(seed);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let sum = 0;
			// 2x2 supersampling: real camera edges are not pixel-sharp, and the
			// subpixel edge fit should be exercised against soft ones.
			for (let sy = 0; sy < 2; sy++) {
				for (let sx = 0; sx < 2; sx++) {
					const px = x + 0.25 + sx * 0.5;
					const py = y + 0.25 + sy * 0.5;
					const uv = mat3Apply(Hinv, px, py);
					if (uv && uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1) {
						sum += content(uv[0], uv[1], t);
					} else {
						// Room: dark, but not flat - a wall gradient and some furniture.
						const wall = room + 10 * (py / h) + (px > w * 0.8 ? 12 : 0);
						sum += wall;
					}
				}
			}
			data[y * w + x] = sum / 4 + (rand() - 0.5) * 2 * noise;
		}
	}
	return { data, w, h };
}

// A hand-held camera: slow drift, a little roll, a little zoom, and the
// perspective slowly changing as the viewer shifts sideways.
export function handHeldQuad(frame, { w = 320, h = 240, amplitude = 1 } = {}) {
	const base = [[74, 62], [251, 44], [263, 183], [61, 171]];
	const t = frame / 30;
	const cx = base.reduce((s, p) => s + p[0], 0) / 4;
	const cy = base.reduce((s, p) => s + p[1], 0) / 4;
	const rot = 0.09 * amplitude * Math.sin(t * 0.9);
	const scale = 1 + 0.07 * amplitude * Math.sin(t * 1.3 + 0.6);
	const dx = 16 * amplitude * Math.sin(t * 1.6);
	const dy = 10 * amplitude * Math.sin(t * 1.1 + 1.2);
	// Slant grows and shrinks: the right-hand corners squeeze towards the centre.
	const slant = 0.06 * amplitude * Math.sin(t * 0.7 + 2);
	return base.map(([x, y], i) => {
		const right = i === 1 || i === 2;
		const sy = right ? 1 - slant : 1 + slant;
		const rx = (x - cx) * scale;
		const ry = (y - cy) * scale * sy;
		return [
			cx + rx * Math.cos(rot) - ry * Math.sin(rot) + dx,
			cy + rx * Math.sin(rot) + ry * Math.cos(rot) + dy,
		];
	});
}

// Pinhole projection of a real w x h rectangle, for the aspect-ratio tests.
export function projectRect({ aspect, yaw = 0.5, pitch = 0.2, distance = 6, focal = 700, principal = [160, 120], offset = [0, 0] }) {
	const corners = [
		[-aspect / 2, -0.5], [aspect / 2, -0.5], [aspect / 2, 0.5], [-aspect / 2, 0.5],
	];
	const cy = Math.cos(yaw), sy = Math.sin(yaw);
	const cp = Math.cos(pitch), sp = Math.sin(pitch);
	return corners.map(([X, Y]) => {
		// Rotate about Y then X, then push away from the camera.
		let x = X * cy, y = Y, z = -X * sy;
		const y2 = y * cp - z * sp;
		const z2 = y * sp + z * cp;
		const Z = z2 + distance;
		return [
			principal[0] + (focal * (x + offset[0])) / Z,
			principal[1] + (focal * (y2 + offset[1])) / Z,
		];
	});
}

// A hand-held view of a real 16:9 screen: the camera drifts sideways, rolls a
// little and changes angle, all as honest 3D motion so the recovered aspect
// ratio can be checked against a known truth.
export function orbitQuad(frame, { aspect = 16 / 9, focal = 700, still = false } = {}) {
	const t = still ? 0 : frame / 30;
	return orderQuad(projectRect({
		aspect,
		focal,
		yaw: 0.35 + 0.28 * Math.sin(t * 0.9),
		pitch: 0.12 * Math.sin(t * 1.3 + 0.4),
		distance: 6 + 0.5 * Math.sin(t * 0.7),
		offset: [0.35 * Math.sin(t * 1.6), 0.22 * Math.sin(t * 1.15 + 1)],
	}));
}

// Zooming in on the screen: it grows past the edges of the view while the hand
// keeps moving. By the end all four corners are well outside the frame.
export function zoomQuad(frame, { rate = 0.026, centre = [160, 120] } = {}) {
	const scale = 1 + rate * frame;
	return orbitQuad(frame / 3).map(([x, y]) => [
		centre[0] + (x - centre[0]) * scale,
		centre[1] + (y - centre[1]) * scale,
	]);
}

// Paint something opaque and dark over part of the view: a head, a chair back,
// someone walking past.
export function occlude(gray, { x, y, w, h, value = 16 }) {
	for (let py = Math.max(0, y | 0); py < Math.min(gray.h, y + h); py++) {
		for (let px = Math.max(0, x | 0); px < Math.min(gray.w, x + w); px++) {
			gray.data[py * gray.w + px] = value;
		}
	}
	return gray;
}
