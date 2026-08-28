import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCKED, SEARCHING, ScreenPipeline } from '../js/pipeline.js';
import { darkPixel, orbitQuad, renderScene } from './synth.mjs';

const W = 320, H = 240;
const maxCornerError = (found, truth) =>
	Math.max(...found.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));
const frameAt = (i, opts = {}) =>
	renderScene({ w: W, h: H, quad: opts.quad ?? orbitQuad(i, opts), t: i, seed: 7 + i, ...opts });

// Hold the camera roughly still until the pipeline reports a lock.
function acquire(pipe, { limit = 25, still = true, from = 0 } = {}) {
	for (let i = 0; i < limit; i++) {
		const out = pipe.update(frameAt(from + i, { still }));
		if (out.state === LOCKED) return i + 1;
	}
	return null;
}

test('locks onto a screen held in view, then follows the camera for 150 frames', () => {
	const pipe = new ScreenPipeline(W, H);
	const frames = acquire(pipe);
	assert.ok(frames !== null, 'never locked on');
	assert.ok(frames <= 10, `took ${frames} frames to lock`);
	assert.ok(maxCornerError(pipe.quad, orbitQuad(0, { still: true })) < 4);

	let worst = 0;
	for (let i = 1; i <= 150; i++) {
		const out = pipe.update(frameAt(i));
		assert.equal(out.state, LOCKED, `dropped the lock at frame ${i}`);
		worst = Math.max(worst, maxCornerError(out.quad, orbitQuad(i)));
	}
	assert.ok(worst < 4, `worst corner error while moving: ${worst}`);
});

test('reports the true 16:9 shape of the screen, not its shape in the image', () => {
	const pipe = new ScreenPipeline(W, H);
	assert.ok(acquire(pipe) !== null);
	for (let i = 1; i <= 60; i++) pipe.update(frameAt(i));
	assert.ok(pipe.aspect, 'no aspect estimate');
	assert.ok(Math.abs(pipe.aspect - 16 / 9) / (16 / 9) < 0.08, `aspect ${pipe.aspect}`);
	// The quad in the image is visibly narrower than 16:9 at this angle, which
	// is the whole reason the estimate has to be geometric.
	const q = pipe.quad;
	const imageRatio = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) /
		Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
	assert.ok(Math.abs(imageRatio - 16 / 9) > 0.15, `image ratio ${imageRatio} was already correct`);
});

test('coasts through a brief blackout, gives up on a long one, then re-acquires', () => {
	const pipe = new ScreenPipeline(W, H);
	assert.ok(acquire(pipe) !== null);
	const quad = orbitQuad(0, { still: true });

	// A cut to black for three frames: keep the lock, flag it as coasting.
	for (let i = 0; i < 3; i++) {
		const out = pipe.update(renderScene({ w: W, h: H, quad, content: darkPixel }));
		assert.equal(out.state, LOCKED);
		assert.ok(out.coasting);
	}
	// Back to picture: the outline is still right where it was.
	const back = pipe.update(renderScene({ w: W, h: H, quad, t: 4 }));
	assert.equal(back.state, LOCKED);
	assert.ok(!back.coasting);
	assert.ok(maxCornerError(back.quad, quad) < 4);

	// Now cover the screen for a long stretch - the lock should be dropped.
	let dropped = false;
	for (let i = 0; i < 12 && !dropped; i++) {
		dropped = pipe.update(renderScene({ w: W, h: H, quad, content: darkPixel })).state === SEARCHING;
	}
	assert.ok(dropped, 'kept claiming a lock on a screen it could not see');

	assert.ok(acquire(pipe) !== null, 'never re-acquired after the blackout');
	assert.ok(maxCornerError(pipe.quad, quad) < 4);
});

test('a hand-placed outline goes straight to tracking', () => {
	const pipe = new ScreenPipeline(W, H);
	const truth = orbitQuad(0, { still: true });
	const rough = truth.map(([x, y], i) => [x + (i % 2 ? 5 : -5), y + (i < 2 ? -4 : 4)]);
	assert.ok(pipe.seed(rough));
	assert.equal(pipe.state, LOCKED);
	for (let i = 0; i < 12; i++) pipe.update(frameAt(i, { still: true }));
	assert.ok(maxCornerError(pipe.quad, truth) < 3, `corner error ${maxCornerError(pipe.quad, truth)}`);
	assert.equal(pipe.seed([[0, 0], [10, 0], [0, 10], [10, 10]]), false, 'self-crossing outline accepted');
});

test('an empty room never claims a lock', () => {
	const pipe = new ScreenPipeline(W, H);
	const quad = [[0, 0], [W, 0], [W, H], [0, H]];
	for (let i = 0; i < 20; i++) {
		const out = pipe.update(renderScene({ w: W, h: H, quad, content: darkPixel, room: 22, seed: i }));
		assert.equal(out.state, SEARCHING);
	}
});
