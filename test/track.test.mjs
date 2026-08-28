import test from 'node:test';
import assert from 'node:assert/strict';
import { trackQuad } from '../js/track.js';
import { darkPixel, handHeldQuad, moviePixel, renderScene } from './synth.mjs';

const W = 320, H = 240;
const maxCornerError = (found, truth) =>
	Math.max(...found.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));
const nudge = (quad, dx, dy) => quad.map(([x, y]) => [x + dx, y + dy]);

test('pulls a roughly-placed outline back onto the screen edges', () => {
	const quad = handHeldQuad(0);
	const frame = renderScene({ w: W, h: H, quad, t: 0 });
	const tracked = trackQuad(frame, nudge(quad, 4, -3));
	assert.ok(tracked, 'lost the outline');
	assert.ok(maxCornerError(tracked.quad, quad) < 1.2, `corner error ${maxCornerError(tracked.quad, quad)}`);
	assert.ok(tracked.confidence > 0.8, `confidence ${tracked.confidence}`);
});

test('follows a hand-held camera for 120 frames of changing content', () => {
	let outline = handHeldQuad(0);
	let worst = 0;
	for (let i = 0; i < 120; i++) {
		const truth = handHeldQuad(i);
		const frame = renderScene({ w: W, h: H, quad: truth, t: i, seed: 7 + i });
		const tracked = trackQuad(frame, outline);
		assert.ok(tracked, `lost the screen at frame ${i}`);
		outline = tracked.quad;
		worst = Math.max(worst, maxCornerError(outline, truth));
	}
	assert.ok(worst < 2, `worst corner error over the sequence: ${worst}`);
});

test('survives a fast pan: the search radius covers a big jump between frames', () => {
	const truth = handHeldQuad(0);
	const frame = renderScene({ w: W, h: H, quad: truth, t: 0 });
	const tracked = trackQuad(frame, nudge(truth, 9, 7));
	assert.ok(tracked);
	assert.ok(maxCornerError(tracked.quad, truth) < 1.5);
});

test('does not wander onto contrast inside the picture', () => {
	// Content with a hard vertical edge just inside the left border - the sort
	// of thing that pulls a polarity-blind edge tracker off the screen.
	const content = (u, v, t) => (u > 0.08 && u < 0.5 ? 40 : moviePixel(u, v, t));
	const truth = handHeldQuad(0);
	const frame = renderScene({ w: W, h: H, quad: truth, t: 0, content });
	const tracked = trackQuad(frame, nudge(truth, 3, 0));
	assert.ok(tracked);
	assert.ok(maxCornerError(tracked.quad, truth) < 2, `corner error ${maxCornerError(tracked.quad, truth)}`);
});

test('reports failure on a black screen rather than inventing an outline', () => {
	const truth = handHeldQuad(0);
	const frame = renderScene({ w: W, h: H, quad: truth, content: darkPixel });
	assert.equal(trackQuad(frame, truth), null);
});

test('carries one edge that has left the frame, gives up when two have', () => {
	// Screen wider than the view: left and right edges are off-image.
	const wide = [[-40, 50], [360, 44], [366, 190], [-46, 182]];
	const frame = renderScene({ w: W, h: H, quad: wide, t: 3 });
	assert.equal(trackQuad(frame, wide), null, 'two missing edges should lose the lock');

	const oneOut = [[-40, 50], [250, 44], [258, 186], [-46, 182]];
	const frame2 = renderScene({ w: W, h: H, quad: oneOut, t: 3 });
	const tracked = trackQuad(frame2, nudge(oneOut, 2, 2));
	assert.ok(tracked, 'one missing edge should still track');
	assert.equal(tracked.weakEdges, 1);
	assert.ok(Math.hypot(tracked.quad[1][0] - oneOut[1][0], tracked.quad[1][1] - oneOut[1][1]) < 2);
});

test('a bright shot inside the picture does not out-vote the edge of the screen', () => {
	// A band brighter than anything else, parallel to the right edge and a few
	// pixels inside it: the strongest luminance step in the search window is
	// the wrong one, and every sample along the edge agrees on it, so nothing
	// but the room-versus-picture test can tell them apart.
	const content = (u, v, t) => (u > 0.88 && u < 0.94 ? 250 : moviePixel(u, v, t));
	let outline = handHeldQuad(0);
	for (let i = 0; i < 40; i++) {
		const truth = handHeldQuad(i);
		const tracked = trackQuad(renderScene({ w: W, h: H, quad: truth, t: i, content }), outline);
		assert.ok(tracked, `lost the screen at frame ${i}`);
		outline = tracked.quad;
		assert.ok(maxCornerError(outline, truth) < 2.5, `frame ${i}: error ${maxCornerError(outline, truth)}`);
	}
});

test('keeps an edge that is partly covered up', () => {
	const truth = handHeldQuad(0);
	const frame = renderScene({ w: W, h: H, quad: truth, t: 0 });
	// A dark object over the left third of the bottom edge.
	for (let y = 150; y < 200; y++) {
		for (let x = 40; x < 120; x++) frame.data[y * W + x] = 18;
	}
	const tracked = trackQuad(frame, nudge(truth, 2, -2));
	assert.ok(tracked, 'gave up on a partly covered edge');
	assert.ok(maxCornerError(tracked.quad, truth) < 3, `corner error ${maxCornerError(tracked.quad, truth)}`);
});
