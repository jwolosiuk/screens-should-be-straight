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

test('says it saw nothing on a black screen rather than inventing evidence', () => {
	const truth = handHeldQuad(0);
	const frame = renderScene({ w: W, h: H, quad: truth, content: darkPixel });
	const tracked = trackQuad(frame, truth);
	// The outline it hands back is just the prior it was given; what matters is
	// that it reports zero measured edges, so the caller knows it is coasting.
	assert.equal(tracked.edges, 0);
	assert.equal(tracked.confidence, 0);
	assert.ok(maxCornerError(tracked.quad, truth) < 0.5);
});

test('tracks on the edges it can still see when the screen overflows the view', () => {
	// Screen wider than the view: the left and right edges are off-image
	// entirely, and all four corners are outside the frame.
	const wide = [[-40, 50], [360, 44], [366, 190], [-46, 182]];
	const frame = renderScene({ w: W, h: H, quad: wide, t: 3 });
	const tracked = trackQuad(frame, nudge(wide, 2, 3));
	assert.ok(tracked, 'two visible edges should be enough to keep going');
	assert.deepEqual(tracked.seen, [true, false, true, false], 'top and bottom seen, sides not');
	// The top and bottom edges are pinned by measurement, so the corners are
	// right in the direction that was measured; sideways they follow the prior.
	for (const corner of [0, 1, 2, 3]) {
		const dy = Math.abs(tracked.quad[corner][1] - wide[corner][1]);
		assert.ok(dy < 3.5, `corner ${corner} drifted ${dy.toFixed(1)}px across the measured edge`);
	}
});

test('an object covering a whole edge costs that edge, not the lock', () => {
	const truth = handHeldQuad(0);
	const frame = renderScene({ w: W, h: H, quad: truth, t: 0 });
	// Something large and dark in front of the bottom of the screen - a head, a
	// chair back - covering that edge completely and part of two others.
	for (let y = 140; y < 240; y++) {
		for (let x = 30; x < 290; x++) frame.data[y * W + x] = 16;
	}
	const tracked = trackQuad(frame, nudge(truth, 2, -2));
	assert.ok(tracked, 'lost the screen to an obstruction');
	assert.equal(tracked.seen[2], false, 'the covered bottom edge should not be claimed as measured');
	assert.ok(tracked.edges >= 1, 'should still have measured something');
	// The top edge is clear, so the top corners stay put.
	for (const corner of [0, 1]) {
		assert.ok(Math.hypot(tracked.quad[corner][0] - truth[corner][0], tracked.quad[corner][1] - truth[corner][1]) < 3,
			`corner ${corner} moved under the obstruction`);
	}
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
