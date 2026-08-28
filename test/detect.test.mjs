import test from 'node:test';
import assert from 'node:assert/strict';
import { Acquirer, otsuThreshold } from '../js/detect.js';
import { LETTERBOX, darkPixel, handHeldQuad, letterboxPixel, renderScene, subQuad } from './synth.mjs';

const W = 320, H = 240;
const maxCornerError = (found, truth) =>
	Math.max(...found.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));

test('otsu splits a two-peak histogram between the peaks', () => {
	const hist = new Int32Array(256);
	for (let i = 20; i < 40; i++) hist[i] = 500;
	for (let i = 180; i < 210; i++) hist[i] = 300;
	const total = hist.reduce((s, v) => s + v, 0);
	const t = otsuThreshold(hist, total);
	assert.ok(t >= 39 && t < 180, `threshold ${t}`);
});

test('finds a screen showing a bright frame', () => {
	const quad = handHeldQuad(0);
	const acq = new Acquirer(W, H);
	for (let i = 0; i < 6; i++) acq.push(renderScene({ w: W, h: H, quad, t: i }));
	const found = acq.detect();
	assert.ok(found, 'nothing detected');
	assert.ok(maxCornerError(found, quad) < 3, `corner error ${maxCornerError(found, quad)}`);
});

test('a dark scene alone is not enough, but the peak image carries it', () => {
	const quad = handHeldQuad(0);
	const dark = new Acquirer(W, H);
	dark.push(renderScene({ w: W, h: H, quad, content: darkPixel }));
	assert.equal(dark.detect(), null, 'a single dark frame should not produce a lock');

	// A couple of lit frames, then the scene cuts to near-black: the screen is
	// still where it was and acquisition should still report it.
	const acq = new Acquirer(W, H);
	for (let i = 0; i < 4; i++) acq.push(renderScene({ w: W, h: H, quad, t: i }));
	for (let i = 0; i < 4; i++) acq.push(renderScene({ w: W, h: H, quad, content: darkPixel }));
	const found = acq.detect();
	assert.ok(found, 'lost the screen across a dark cut');
	assert.ok(maxCornerError(found, quad) < 3.5, `corner error ${maxCornerError(found, quad)}`);
});

test('letterboxed content locks onto the picture, not the invisible panel edge', () => {
	const quad = handHeldQuad(0);
	const acq = new Acquirer(W, H);
	for (let i = 0; i < 6; i++) acq.push(renderScene({ w: W, h: H, quad, t: i, content: letterboxPixel }));
	const found = acq.detect();
	assert.ok(found);
	const picture = subQuad(quad, LETTERBOX, 1 - LETTERBOX);
	assert.ok(maxCornerError(found, picture) < 3.5, `corner error ${maxCornerError(found, picture)}`);
});

test('an empty dark room produces no false lock', () => {
	const acq = new Acquirer(W, H);
	const quad = [[0, 0], [W, 0], [W, H], [0, H]];
	for (let i = 0; i < 6; i++) acq.push(renderScene({ w: W, h: H, quad, content: darkPixel, room: 24 }));
	assert.equal(acq.detect(), null);
});

test('a small bright lamp is rejected: it does not fill its own quad', () => {
	const acq = new Acquirer(W, H);
	const lamp = { data: new Uint8ClampedArray(W * H).fill(20), w: W, h: H };
	for (let y = 90; y < 150; y++) {
		for (let x = 130; x < 190; x++) {
			// A round blob, not a rectangle.
			if (Math.hypot(x - 160, y - 120) < 30) lamp.data[y * W + x] = 240;
		}
	}
	for (let i = 0; i < 6; i++) acq.push(lamp);
	assert.equal(acq.detect(), null);
});
