// A lit bedroom with a tablet - the scene from a photograph of the app failing.
// The room is bright and warm, the bedding is white, and brightness alone
// cannot tell the screen from the wall. What can: the picture changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCKED, SEARCHING, ScreenPipeline } from '../js/pipeline.js';
import { rgbaToChannels } from '../js/image.js';
import { ChangeFeed, orbitQuad, renderBedroom } from './synth.mjs';

const W = 320, H = 240;
const maxCornerError = (found, truth) =>
	Math.max(...found.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));

// Feeds the pipeline the way the app does: each frame's light channel plus the
// change against the previous frame.
function makeStepper(pipe) {
	const feed = new ChangeFeed();
	return (scene) => {
		return pipe.update(feed.push(rgbaToChannels(scene.rgba, W, H)));
	};
}

// The tablet: modest size, well inside the frame, at an angle.
const tablet = (i, still = true) =>
	orbitQuad(still ? 0 : i, { still }).map(([x, y]) => [96 + (x - 160) * 0.55, 118 + (y - 120) * 0.55]);

test('locks onto the tablet, not the lamp-lit wall, and never says "zoom out"', () => {
	const pipe = new ScreenPipeline(W, H);
	const step = makeStepper(pipe);
	let locked = 0;
	for (let i = 0; i < 45 && !locked; i++) {
		const out = step(renderBedroom({ w: W, h: H, picture: tablet(0), t: i, seed: 21 + i }));
		assert.ok(!out.clipped, `frame ${i}: told the user to zoom out with the whole screen in view`);
		if (out.state === LOCKED) locked = i;
	}
	assert.ok(locked, 'never locked onto the tablet');
	// Acquisition from change is approximate by design - a film's activity is
	// patchy, so the blob is ragged and the seed lands near rather than on the
	// screen. What matters is that it lands on the SCREEN (the room would be a
	// hundred pixels out) and that the tracker closes the gap immediately.
	assert.ok(maxCornerError(pipe.quad, tablet(0)) < 25,
		`locked ${maxCornerError(pipe.quad, tablet(0)).toFixed(1)}px away - probably onto the room`);
	for (let i = 0; i < 5; i++) {
		step(renderBedroom({ w: W, h: H, picture: tablet(0), t: locked + i, seed: 21 + locked + i }));
	}
	assert.ok(maxCornerError(pipe.quad, tablet(0)) < 4,
		`did not converge: ${maxCornerError(pipe.quad, tablet(0)).toFixed(1)}px away after five frames`);
});

test('a hand-placed outline survives in a lit room instead of self-destructing', () => {
	const pipe = new ScreenPipeline(W, H);
	const step = makeStepper(pipe);
	// Warm up the change statistics, then seed the way the Adjust button does.
	step(renderBedroom({ w: W, h: H, picture: tablet(0), t: 0, seed: 21 }));
	assert.ok(pipe.seed(tablet(0).map(([x, y], k) => [x + (k % 2 ? 3 : -3), y + (k < 2 ? -3 : 3)])));
	for (let i = 1; i <= 60; i++) {
		const out = step(renderBedroom({ w: W, h: H, picture: tablet(0), t: i, seed: 21 + i }));
		assert.equal(out.state, LOCKED,
			`dropped the hand-placed outline at frame ${i} - the bright wall must not count as stray light`);
	}
	assert.ok(maxCornerError(pipe.quad, tablet(0)) < 4,
		`outline drifted to ${maxCornerError(pipe.quad, tablet(0)).toFixed(1)}px`);
});

test('the periodic fresh look does not hand the outline to the room', () => {
	const pipe = new ScreenPipeline(W, H, { sanityEvery: 5 });
	const step = makeStepper(pipe);
	step(renderBedroom({ w: W, h: H, picture: tablet(0), t: 0, seed: 21 }));
	assert.ok(pipe.seed(tablet(0)));
	for (let i = 1; i <= 40; i++) {
		step(renderBedroom({ w: W, h: H, picture: tablet(0), t: i, seed: 21 + i }));
	}
	assert.ok(maxCornerError(pipe.quad, tablet(0)) < 4,
		`outline was re-seeded ${maxCornerError(pipe.quad, tablet(0)).toFixed(1)}px away - slippage check took the room`);
	assert.equal(pipe.slips, 0, 'slippage check fired in a steady lit room');
});

test('a paused film in a lit room stays honest: no lock, no "zoom out"', () => {
	const pipe = new ScreenPipeline(W, H);
	const step = makeStepper(pipe);
	for (let i = 0; i < 40; i++) {
		const out = step(renderBedroom({ w: W, h: H, picture: tablet(0), t: i, seed: 21 + i, paused: true }));
		assert.equal(out.state, SEARCHING, 'locked onto something in a scene with no playing screen');
		assert.ok(!out.clipped, 'told the user to zoom out of a room');
	}
});

test('hand shake does not fake a screen out of wall texture', () => {
	const pipe = new ScreenPipeline(W, H);
	const step = makeStepper(pipe);
	for (let i = 0; i < 40; i++) {
		// Shake, and a paused film: all change comes from the camera moving.
		const out = step(renderBedroom({
			w: W, h: H, picture: tablet(0), t: i, seed: 21 + i, paused: true,
			shake: 1.5 * Math.sin(i * 2.1),
		}));
		assert.equal(out.state, SEARCHING, `locked onto shake-induced change at frame ${i}`);
	}
});
