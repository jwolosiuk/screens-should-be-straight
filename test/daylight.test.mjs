// A television on a wall in a room full of daylight, reconstructed from
// measurements off a recording of this app failing in that room. Every other
// scene in this suite is a dark one, where the screen is the brightest thing
// in view; here the wall is, and the app was blind to the set entirely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCKED, SEARCHING, ScreenPipeline } from '../js/pipeline.js';
import { rgbaToChannels } from '../js/image.js';
import { ChangeFeed, orbitQuad, renderDaylightRoom } from './synth.mjs';

const W = 320, H = 255;
const maxCornerError = (found, truth) =>
	Math.max(...found.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));
// A set of modest size, well inside the frame, seen slightly from the side -
// as in the photograph: about a third of the width, an eighth of the height.
const television = orbitQuad(0, { still: true }).map(([x, y]) => [88 + (x - 160) * 0.58, 88 + (y - 120) * 0.62]);

function stepper(pipe, opts = {}) {
	const feed = new ChangeFeed();
	return (extra) => {
		const scene = renderDaylightRoom({ w: W, h: H, picture: television, ...opts, ...extra });
		const { light, change, motion, restless, warp } = feed.push(rgbaToChannels(scene.rgba, W, H));
		return pipe.update(light, change, motion, restless, warp);
	};
}

test('the wall is brighter than the picture, which is the whole difficulty', () => {
	const scene = renderDaylightRoom({ w: W, h: H, picture: television, t: 5 });
	const { light } = rgbaToChannels(scene.rgba, W, H);
	const at = (x, y) => light.data[Math.round(y) * W + Math.round(x)];
	const mid = Math.round((television[0][1] + television[3][1]) / 2);
	const wall = at(20, mid);
	const bezel = Math.min(...Array.from({ length: 6 }, (_, i) => at(television[0][0] - 5 + i, mid)));
	let brightestPicture = 0, darkestPicture = 255;
	for (let x = television[0][0] + 8; x < television[1][0] - 8; x += 3) {
		const v = at(Math.round(x), mid);
		brightestPicture = Math.max(brightestPicture, v);
		darkestPicture = Math.min(darkestPicture, v);
	}
	// The measured profile from the real recording: wall 175, bezel 22,
	// picture 30-255. If the scene ever stops looking like that, the test
	// below stops testing what it claims to.
	assert.ok(wall > 150 && wall < 230, `wall ${wall}`);
	assert.ok(bezel < 45, `bezel ${bezel}`);
	assert.ok(darkestPicture < wall, `the picture should be partly dimmer than the wall (${darkestPicture} vs ${wall})`);
	assert.ok(brightestPicture > wall, `and partly brighter (${brightestPicture} vs ${wall})`);
});

test('locks onto a television in a sunlit room and holds it', () => {
	const pipe = new ScreenPipeline(W, H);
	const step = stepper(pipe);
	let locked = -1;
	for (let i = 0; i < 90 && locked < 0; i++) {
		if (step({ t: i, seed: 41 + i, shake: 0.8 * Math.sin(i * 2.1) }).state === LOCKED) locked = i;
	}
	assert.ok(locked >= 0, 'never found a television playing in plain view');
	// Acquisition from change is approximate; the tracker closes the gap.
	for (let i = 0; i < 10; i++) step({ t: locked + i, seed: 41 + locked + i, shake: 0.8 * Math.sin(i * 2.1) });
	assert.ok(maxCornerError(pipe.quad, television) < 8,
		`settled ${maxCornerError(pipe.quad, television).toFixed(1)}px from the set`);
	let dropped = 0;
	for (let i = locked + 10; i < locked + 160; i++) {
		const out = step({ t: i, seed: 41 + i, shake: 0.8 * Math.sin(i * 2.1) });
		if (out.state !== LOCKED) dropped++;
	}
	assert.ok(dropped < 15, `lost the lock on ${dropped} of 150 frames in a lit room`);
	assert.ok(maxCornerError(pipe.quad, television) < 8,
		`drifted to ${maxCornerError(pipe.quad, television).toFixed(1)}px`);
});

test('a radiator is not a screen, however much a shaking hand makes it change', () => {
	// The fins produce as much change as the film. What separates them is
	// magnitude and shape, not the mere presence of change.
	const pipe = new ScreenPipeline(W, H);
	const step = stepper(pipe, { paused: true, mirror: false });
	for (let i = 0; i < 60; i++) {
		const out = step({ t: i, seed: 41 + i, shake: 1.6 * Math.sin(i * 2.1) });
		assert.equal(out.state, SEARCHING, `locked onto the room at frame ${i}`);
	}
});

test('a mirror showing the same film does not steal the lock', () => {
	const pipe = new ScreenPipeline(W, H);
	const step = stepper(pipe);
	let locked = -1;
	for (let i = 0; i < 90 && locked < 0; i++) {
		if (step({ t: i, seed: 41 + i }).state === LOCKED) locked = i;
	}
	assert.ok(locked >= 0, 'never locked');
	for (let i = 0; i < 120; i++) step({ t: locked + i, seed: 41 + locked + i, shake: 0.6 * Math.sin(i * 2.1) });
	assert.equal(pipe.state, LOCKED, 'the reflection took the lock');
	assert.ok(maxCornerError(pipe.quad, television) < 10,
		`ended ${maxCornerError(pipe.quad, television).toFixed(1)}px away - the mirror is a third the size and up to the right`);
});
