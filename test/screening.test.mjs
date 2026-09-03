// The case this app was actually built for: an outdoor screening at night.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCKED, ScreenPipeline } from '../js/pipeline.js';
import { makeGray, rgbaToScreenLight } from '../js/image.js';
import { frontRow, orbitQuad, renderScreening } from './synth.mjs';

const W = 320, H = 240;
// Scenes that predate the change channel hand the pipeline a light frame
// and nothing else, which is exactly what a caller with no better evidence
// does: everything falls back to brightness.
const asFrame = (light) => ({ light });
const maxCornerError = (found, truth) =>
	Math.max(...found.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));
const gray = makeGray(W, H);
const frame = (opts) => {
	const scene = renderScreening({ w: W, h: H, ...opts });
	return rgbaToScreenLight(scene.rgba, W, H, gray);
};

test('finds the projected picture on an inflatable screen, not the screen', () => {
	const picture = orbitQuad(0, { still: true });
	const pipe = new ScreenPipeline(W, H);
	for (let i = 0; i < 25 && pipe.state !== LOCKED; i++) pipe.update(asFrame(frame({ picture, t: i })));
	assert.equal(pipe.state, LOCKED, 'never locked on');
	// The screen surface is 16% larger than the picture in every direction. A
	// lock on the surface would be a lock on grey margins the film is not in.
	assert.ok(maxCornerError(pipe.quad, picture) < 5,
		`locked ${maxCornerError(pipe.quad, picture).toFixed(1)}px from the picture - probably onto the surface`);
});

test('a deep red reel is still brighter than the screen it is projected on', () => {
	const picture = orbitQuad(0, { still: true });
	const pipe = new ScreenPipeline(W, H);
	for (let i = 0; i < 25 && pipe.state !== LOCKED; i++) {
		pipe.update(asFrame(frame({ picture, t: i, palette: 'red' })));
	}
	assert.equal(pipe.state, LOCKED, 'lost a saturated red picture against a grey screen');
	assert.ok(maxCornerError(pipe.quad, picture) < 5, `corner error ${maxCornerError(pipe.quad, picture).toFixed(1)}px`);
});

test('heads in the front row do not move the bottom edge', () => {
	const pipe = new ScreenPipeline(W, H);
	const still = orbitQuad(0, { still: true });
	// Roughly what the photographs show: three heads taking out about two
	// fifths of the bottom edge between them, each rising a little above it.
	// They are separate arcs at different heights, not one straight line, which
	// is why the fit can prefer the edge they are sitting in front of.
	assert.ok(frontRow(still).coverage > 0.35 && frontRow(still).coverage < 0.5,
		`front row should obstruct about 40% of the edge, got ${(frontRow(still).coverage * 100).toFixed(0)}%`);
	for (let i = 0; i < 25 && pipe.state !== LOCKED; i++) {
		pipe.update(asFrame(frame({ picture: still, t: i, heads: frontRow(still) })));
	}
	assert.equal(pipe.state, LOCKED, 'never locked on with the front row in the way');
	let worst = 0;
	for (let i = 1; i <= 60; i++) {
		const picture = orbitQuad(i);
		const out = pipe.update(asFrame(frame({ picture, t: i, heads: frontRow(picture), seed: 11 + i })));
		assert.equal(out.state, LOCKED, `lost the screen at frame ${i}`);
		worst = Math.max(worst, maxCornerError(out.quad, picture));
	}
	assert.ok(worst < 6, `worst corner error with heads in the way: ${worst.toFixed(1)}px`);
});
