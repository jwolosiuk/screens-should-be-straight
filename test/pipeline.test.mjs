import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCKED, SEARCHING, ScreenPipeline } from '../js/pipeline.js';
import { ChangeFeed, darkPixel, occlude, orbitQuad, renderScene, zoomQuad } from './synth.mjs';

const W = 320, H = 240;
// Scenes that predate the change channel hand the pipeline a light frame
// and nothing else, which is exactly what a caller with no better evidence
// does: everything falls back to brightness.
const asFrame = (light) => ({ light });
const maxCornerError = (found, truth) =>
	Math.max(...found.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));
const frameAt = (i, opts = {}) =>
	renderScene({ w: W, h: H, quad: opts.quad ?? orbitQuad(i, opts), t: i, seed: 7 + i, ...opts });

// Feed frames the way the app does: light plus the change against a rolling
// reference. These scenes are single-channel, so light doubles as plain.
function feeder(pipe) {
	const feed = new ChangeFeed();
	return (gray) => {
		return pipe.update(feed.push({ light: gray, plain: gray }));
	};
}

// Hold the camera roughly still until the pipeline reports a lock.
function acquire(pipe, { limit = 25, still = true, from = 0 } = {}) {
	for (let i = 0; i < limit; i++) {
		const out = pipe.update(asFrame(frameAt(from + i, { still })));
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
		const out = pipe.update(asFrame(frameAt(i)));
		assert.equal(out.state, LOCKED, `dropped the lock at frame ${i}`);
		worst = Math.max(worst, maxCornerError(out.quad, orbitQuad(i)));
	}
	assert.ok(worst < 4, `worst corner error while moving: ${worst}`);
});

test('reports the true 16:9 shape of the screen, not its shape in the image', () => {
	const pipe = new ScreenPipeline(W, H);
	assert.ok(acquire(pipe) !== null);
	// Long enough for the vanishing-point construction to hit its unstable
	// patches: a few frames in every few hundred come back degenerate even while
	// tracking is perfect, and averaging those in used to stretch the picture.
	let worstReported = 0, mostSkewed = 0;
	for (let i = 1; i <= 300; i++) {
		const out = pipe.update(asFrame(frameAt(i)));
		assert.ok(pipe.aspect, `no aspect estimate at frame ${i}`);
		worstReported = Math.max(worstReported, Math.abs(pipe.aspect - 16 / 9) / (16 / 9));
		// What the quad's own proportions would suggest, which is the answer
		// this whole construction exists to avoid.
		const q = out.quad;
		const naive = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1])
			/ Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
		mostSkewed = Math.max(mostSkewed, Math.abs(naive - 16 / 9) / (16 / 9));
	}
	assert.ok(worstReported < 0.03, `reported aspect drifted by ${(worstReported * 100).toFixed(1)}%`);
	assert.ok(mostSkewed > 0.1, `the view was never angled enough to test anything (${mostSkewed})`);
	assert.ok(mostSkewed > 3 * worstReported,
		`geometry should beat the quad's own proportions by more than this: `
		+ `${(mostSkewed * 100).toFixed(1)}% vs ${(worstReported * 100).toFixed(1)}%`);
});

test('coasts through a brief blackout, gives up on a long one, then re-acquires', () => {
	const pipe = new ScreenPipeline(W, H);
	assert.ok(acquire(pipe) !== null);
	const quad = orbitQuad(0, { still: true });

	// A cut to black for three frames: keep the lock, flag it as coasting.
	for (let i = 0; i < 3; i++) {
		const out = pipe.update(asFrame(renderScene({ w: W, h: H, quad, content: darkPixel })));
		assert.equal(out.state, LOCKED);
		assert.ok(out.coasting);
	}
	// Back to picture: the outline is still right where it was.
	const back = pipe.update(asFrame(renderScene({ w: W, h: H, quad, t: 4 })));
	assert.equal(back.state, LOCKED);
	assert.ok(!back.coasting);
	assert.ok(maxCornerError(back.quad, quad) < 4);

	// Now cover the screen for a long stretch - the lock should be dropped.
	let dropped = false;
	for (let i = 0; i < 12 && !dropped; i++) {
		dropped = pipe.update(asFrame(renderScene({ w: W, h: H, quad, content: darkPixel }))).state === SEARCHING;
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
	for (let i = 0; i < 12; i++) pipe.update(asFrame(frameAt(i, { still: true })));
	assert.ok(maxCornerError(pipe.quad, truth) < 3, `corner error ${maxCornerError(pipe.quad, truth)}`);
	assert.equal(pipe.seed([[0, 0], [10, 0], [0, 10], [10, 10]]), false, 'self-crossing outline accepted');
});

test('an empty room never claims a lock', () => {
	const pipe = new ScreenPipeline(W, H);
	const quad = [[0, 0], [W, 0], [W, H], [0, H]];
	for (let i = 0; i < 20; i++) {
		const out = pipe.update(asFrame(renderScene({ w: W, h: H, quad, content: darkPixel, room: 22, seed: i })));
		assert.equal(out.state, SEARCHING);
	}
});

test('a wrong shape reading corrects itself instead of sticking', () => {
	const pipe = new ScreenPipeline(W, H);
	assert.ok(acquire(pipe) !== null);
	// Whatever the reading at lock happened to be, pretend it was badly wrong -
	// a single unlucky frame can do this. Every later reading now looks like an
	// outlier, which is exactly the situation where rejecting outliers would
	// leave the picture permanently stretched.
	pipe.aspect = 3.1;
	for (let i = 1; i <= 300; i++) pipe.update(asFrame(frameAt(i)));
	assert.ok(Math.abs(pipe.aspect - 16 / 9) / (16 / 9) < 0.05,
		`did not recover from a bad initial reading: ${pipe.aspect}`);
});

test('a centred zoom tracks tightly for as long as any edge is visible', () => {
	// A pinch zoom centres near the middle of the screen, so opposite edges
	// stay in view and the scale is directly observable from their separation.
	// (Zooming about the centre, corners leave the frame LAST - by the time
	// all four are out, every edge is gone too and there is nothing to track;
	// the corners-outside case belongs to the off-centre test below.)
	const centred = (i) => {
		const scale = 1 + 0.026 * i;
		return orbitQuad(0, { still: true }).map(([x, y]) => [160 + (x - 160) * scale, 120 + (y - 120) * scale]);
	};
	const pipe = new ScreenPipeline(W, H);
	for (let i = 0; i < 25 && pipe.state !== LOCKED; i++) {
		pipe.update(asFrame(renderScene({ w: W, h: H, quad: centred(0), t: i, seed: 7 + i })));
	}
	assert.equal(pipe.state, LOCKED, 'never locked before the zoom');
	let worst = 0;
	for (let i = 1; i <= 20; i++) {
		const truth = centred(i);
		const out = pipe.update(asFrame(renderScene({ w: W, h: H, quad: truth, t: i, seed: 7 + i })));
		assert.equal(out.state, LOCKED, `lost the screen at zoom frame ${i}`);
		const width = Math.hypot(truth[1][0] - truth[0][0], truth[1][1] - truth[0][1]);
		worst = Math.max(worst, maxCornerError(out.quad, truth) / width);
	}
	assert.ok(worst < 0.06, `worst corner error through the zoom: ${(worst * 100).toFixed(1)}%`);
});

test('an off-centre zoom degrades bounded and heals when edges return', () => {
	// Walking toward a corner of the screen: the far edges leave first and
	// only two ADJACENT edges stay visible. Every measurement then clusters at
	// their shared corner, and the far corner's speed is genuinely
	// unobservable frame-to-frame - the motion model refuses to invent it, so
	// the outline lags on the unseen side. The contract is honesty either
	// way: the lock survives, the excursion is bounded, and the moment the
	// zoom reverses and edges return, the outline snaps back.
	const pipe = new ScreenPipeline(W, H);
	for (let i = 0; i < 25 && pipe.state !== LOCKED; i++) {
		pipe.update(asFrame(renderScene({ w: W, h: H, quad: zoomQuad(0), t: i, seed: 7 + i })));
	}
	assert.equal(pipe.state, LOCKED);
	let worst = 0;
	for (let i = 1; i <= 90; i++) {
		const truth = zoomQuad(i);
		const out = pipe.update(asFrame(renderScene({ w: W, h: H, quad: truth, t: i, seed: 7 + i })));
		assert.equal(out.state, LOCKED, `lost the screen at zoom frame ${i}`);
		const width = Math.hypot(truth[1][0] - truth[0][0], truth[1][1] - truth[0][1]);
		worst = Math.max(worst, maxCornerError(out.quad, truth) / width);
	}
	assert.ok(worst < 0.55, `excursion unbounded: ${(worst * 100).toFixed(1)}% of screen width`);
	// Zoom back out; the lagging edges come back into view and re-pin.
	for (let i = 91; i <= 180; i++) {
		const truth = zoomQuad(180 - i);
		pipe.update(asFrame(renderScene({ w: W, h: H, quad: truth, t: i, seed: 7 + i })));
	}
	const truth = zoomQuad(0);
	assert.equal(pipe.state, LOCKED, 'lost the lock on the way back out');
	const width = Math.hypot(truth[1][0] - truth[0][0], truth[1][1] - truth[0][1]);
	assert.ok(maxCornerError(pipe.quad, truth) / width < 0.08,
		`did not heal after edges returned: ${(100 * maxCornerError(pipe.quad, truth) / width).toFixed(1)}%`);
});

test('a passing obstruction leaves the tracking alone', () => {
	const pipe = new ScreenPipeline(W, H);
	assert.ok(acquire(pipe) !== null);
	let worst = 0;
	for (let i = 1; i <= 60; i++) {
		const truth = orbitQuad(i);
		const gray = renderScene({ w: W, h: H, quad: truth, t: i, seed: 7 + i });
		// Something crossing the bottom of the view: it takes out part of the
		// bottom edge and the lower third of one side at a time. Any one edge
		// keeps most of its length visible, which is the condition for the line
		// fit to shrug the obstruction off as a minority of bad samples.
		occlude(gray, { x: -40 + i * 4, y: 150, w: 50, h: H });
		const out = pipe.update(asFrame(gray));
		assert.equal(out.state, LOCKED, `lost the screen at frame ${i}`);
		worst = Math.max(worst, maxCornerError(out.quad, truth));
	}
	assert.ok(worst < 6, `worst corner error while obstructed: ${worst.toFixed(1)}px`);
});

test('an obstruction that takes the outline with it is noticed and undone', () => {
	// The hard case, and the app does not win it outright. A tall opaque shape
	// sweeping right across the screen hides one edge completely and offers its
	// own boundary in place of it - dark on one side, lit picture on the other,
	// moving smoothly. Locally there is nothing to tell the two apart, and the
	// outline gets dragged along.
	//
	// What the app must do is notice. Once part of the screen is lit, playing,
	// and outside the outline - while the camera is steady enough to trust the
	// comparison - the outline is no longer describing a screen, and the only
	// honest move is to drop it and look again.
	const pipe = new ScreenPipeline(W, H);
	const step = feeder(pipe);
	let locked = false;
	for (let i = 0; i < 25 && !locked; i++) locked = step(frameAt(i, { still: true })).state === LOCKED;
	assert.ok(locked, 'never locked on');
	let worst = 0, dropped = false, lockedAgain = 0;
	for (let i = 1; i <= 130; i++) {
		const truth = orbitQuad(i);
		const gray = renderScene({ w: W, h: H, quad: truth, t: i, seed: 7 + i });
		if (i <= 60) occlude(gray, { x: -60 + i * 5, y: 0, w: 90, h: H });
		const out = step(gray);
		if (out.state === SEARCHING) { dropped = true; lockedAgain = 0; }
		else lockedAgain++;
		if (out.quad) worst = Math.max(worst, maxCornerError(out.quad, truth));
	}
	assert.ok(dropped, 'followed the obstruction all the way and never questioned it');
	assert.ok(lockedAgain > 30, 'never settled back onto the screen afterwards');
	assert.ok(maxCornerError(pipe.quad, orbitQuad(130)) < 4, 'recovered but onto the wrong thing');
	// The excursion before it gives up is large - the stray check waits for a
	// steady camera, which is the price of not false-firing in a lit room.
	assert.ok(worst < 200, `drifted ${worst.toFixed(0)}px before noticing`);
});
test('a screen larger than the view is never mistaken for one, and never argued with', () => {
	// Standing too close: every corner outside the view, the room barely
	// visible around the edges. The app must not lock onto the shape of the
	// viewport - and it must not instruct the user either. It used to say
	// "zoom out until the whole screen is in view", inferred from where the
	// evidence touched the borders. On a real recording of a television
	// framed perfectly in the middle of a living room, it said exactly that,
	// twice, for seconds at a time. No version of the inference survived
	// contact with a real room, and an instruction to fix something that is
	// not broken is worse than silence.
	const pipe = new ScreenPipeline(W, H);
	const step = feeder(pipe);
	const huge = [[-60, -40], [380, -45], [385, 285], [-70, 280]];
	const filmish = (u, v, t) => {
		const shot = Math.floor(t / 12);
		const blob = Math.hypot(u - (0.5 + 0.3 * Math.sin(shot + t * 0.1)), v - 0.5) < 0.18 ? 60 : 0;
		return Math.max(0, Math.min(255, 120 + blob + 30 * Math.sin(u * 9 + shot * 2 + t * 0.05)));
	};
	for (let i = 0; i < 45; i++) {
		const out = step(renderScene({ w: W, h: H, quad: huge, t: i, seed: 7 + i, content: filmish }));
		assert.equal(out.state, SEARCHING, 'locked onto the shape of the viewport');
		assert.equal(out.clipped, undefined, 'the app should have no opinion about the framing');
	}
});