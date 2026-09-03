// The motion machinery that makes hand-held work: shift estimation, the
// compensated change tracker, and the scenes the verification fleet proved
// broken - tremor, wobble, exposure ramps, mostly-static films.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeTracker, estimateShift, makeGray, rgbaToChannels } from '../js/image.js';
import { LOCKED, SEARCHING, ScreenPipeline } from '../js/pipeline.js';
import { ChangeFeed, orbitQuad, prng, renderBedroom, renderScene } from './synth.mjs';

const W = 320, H = 240;
const maxCornerError = (found, truth) =>
	Math.max(...found.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));
const tablet = orbitQuad(0, { still: true }).map(([x, y]) => [96 + (x - 160) * 0.55, 118 + (y - 120) * 0.55]);

function bedroomStepper(pipe) {
	const feed = new ChangeFeed();
	return (opts) => {
		const scene = renderBedroom({ w: W, h: H, picture: tablet, ...opts });
		return pipe.update(feed.push(rgbaToChannels(scene.rgba, W, H)));
	};
}

test('estimateShift recovers known shifts to a fraction of a pixel', () => {
	// A textured scene: room-like gradients plus some hard edges.
	const rand = prng(5);
	const base = makeGray(W, H);
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			base.data[y * W + x] = 90 + 50 * Math.sin(x * 0.07) * Math.sin(y * 0.05)
				+ (x % 53 < 4 ? 70 : 0) + (rand() - 0.5) * 4;
		}
	}
	const shifted = (dx, dy) => {
		const out = makeGray(W, H);
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const sx = Math.min(W - 1, Math.max(0, x - dx));
				const sy = Math.min(H - 1, Math.max(0, y - dy));
				out.data[y * W + x] = base.data[Math.round(sy) * W + Math.round(sx)];
			}
		}
		return out;
	};
	// Convention: the result is the offset at which to SAMPLE THE REFERENCE,
	// so content moving by +d comes back as -d. What matters is that the
	// tracker warps with the same convention, which the compensation test
	// below exercises end to end.
	for (const [dx, dy] of [[0, 0], [2, 0], [-3, 2], [5, -4]]) {
		const s = estimateShift(shifted(dx, dy), base);
		assert.ok(!s.saturated, `${dx},${dy} saturated`);
		assert.ok(Math.hypot(s.dx + dx, s.dy + dy) < 0.8, `${dx},${dy} -> ${s.dx.toFixed(1)},${s.dy.toFixed(1)}`);
	}
	assert.ok(estimateShift(shifted(10, 0), base).saturated, 'a shift beyond the window must say so');
});

test('compensation keeps a shaking room quiet in the change map', () => {
	const feed = new ChangeFeed();
	let last = null;
	for (let i = 0; i < 30; i++) {
		const scene = renderBedroom({ w: W, h: H, picture: tablet, t: i, seed: 21 + i, paused: true, shake: 1.5 * Math.sin(i * 2.1) });
		last = feed.push(rgbaToChannels(scene.rgba, W, H));
	}
	assert.ok(last.change, 'tremor alone must not invalidate the change frame');
	// Sample the wall region: with a paused film and only tremor, next to
	// nothing should survive the compensated difference.
	let above = 0, n = 0;
	for (let y = 10; y < 80; y += 4) {
		for (let x = 180; x < 310; x += 4) { n++; if (last.change.data[y * W + x] > 10) above++; }
	}
	assert.ok(above / n < 0.1, `${(100 * above / n).toFixed(0)}% of the shaking wall lit up`);
});

test('locks under continuous hand tremor with the film playing - the point of the app', () => {
	const pipe = new ScreenPipeline(W, H);
	const step = bedroomStepper(pipe);
	let locked = -1;
	for (let i = 0; i < 140 && locked < 0; i++) {
		if (step({ t: i, seed: 21 + i, shake: 1.5 * Math.sin(i * 2.1) }).state === LOCKED) locked = i;
	}
	assert.ok(locked >= 0, 'never locked with an ordinary hand tremor');
	for (let i = 0; i < 30; i++) step({ t: locked + i, seed: 21 + locked + i, shake: 1.5 * Math.sin((locked + i) * 2.1) });
	assert.equal(pipe.state, LOCKED, 'lock did not survive continued tremor');
	assert.ok(maxCornerError(pipe.quad, tablet) < 6, `settled ${maxCornerError(pipe.quad, tablet).toFixed(1)}px off`);
});

test('an aiming wobble cannot poison the lock permanently', () => {
	const pipe = new ScreenPipeline(W, H);
	const step = bedroomStepper(pipe);
	// Wobble hard while aiming, then hold reasonably still - the exact motion
	// that used to fuse furniture ghosts into the lock forever.
	for (let i = 0; i < 25; i++) step({ t: i, seed: 21 + i, shake: 8 * Math.sin(i * 0.5) });
	for (let i = 25; i < 140; i++) step({ t: i, seed: 21 + i, shake: 0.4 * Math.sin(i * 2.1) });
	assert.equal(pipe.state, LOCKED, 'never recovered after the wobble');
	assert.ok(maxCornerError(pipe.quad, tablet) < 6,
		`stuck ${maxCornerError(pipe.quad, tablet).toFixed(1)}px away - wobble ghosts survived`);
});

test('an exposure ramp mid-track neither kills the lock nor cries "zoom out"', () => {
	const pipe = new ScreenPipeline(W, H);
	const step = bedroomStepper(pipe);
	for (let i = 0; i < 40; i++) step({ t: i, seed: 21 + i });
	assert.equal(pipe.state, LOCKED, 'no lock before the ramp');
	for (let i = 40; i < 90; i++) {
		const ramp = i < 50 ? 1 + 0.035 * (i - 40) : 1.35;
		const out = step({ t: i, seed: 21 + i, gain: ramp });
		assert.equal(out.state, LOCKED, `exposure ramp killed the lock at frame ${i}`);
		assert.ok(!out.clipped, 'ramp produced a zoom-out hint');
	}
	assert.ok(maxCornerError(pipe.quad, tablet) < 5);
});

test('a mostly-static film in a dark room still locks fast via brightness', () => {
	// An interview shot: only a face-sized region changes. The change evidence
	// is weak and localized; the bright quad containing it must win anyway.
	const face = (u, v, t) => {
		const talking = Math.hypot(u - 0.35, v - 0.45) < 0.16 ? 24 * Math.sin(t * 0.9) : 0;
		return Math.max(0, Math.min(255, 150 + 40 * Math.sin(u * 4) + talking));
	};
	const pipe = new ScreenPipeline(W, H);
	const feed = new ChangeFeed();
	const quad = orbitQuad(0, { still: true });
	let locked = -1;
	for (let i = 0; i < 40 && locked < 0; i++) {
		const g = renderScene({ w: W, h: H, quad, t: i, seed: 7 + i, content: face });
		if (pipe.update(feed.push({ light: g, plain: g })).state === LOCKED) locked = i;
	}
	assert.ok(locked >= 0 && locked <= 12, `took ${locked} frames - the light path was vetoed`);
	assert.ok(maxCornerError(pipe.quad, quad) < 4, `locked onto ${maxCornerError(pipe.quad, quad).toFixed(1)}px off - the talking head?`);
});

test('a flipping subtitle strip at startup does not become the screen', () => {
	const subtitled = (u, v, t) => {
		const strip = v > 0.85 && v < 0.95 && Math.abs(u - 0.5) < 0.3 && (t % 6 < 3) ? 70 : 0;
		return Math.max(0, Math.min(255, 140 + 30 * Math.sin(u * 5 + v * 3) + strip));
	};
	const pipe = new ScreenPipeline(W, H);
	const feed = new ChangeFeed();
	const quad = orbitQuad(0, { still: true });
	let locked = -1;
	for (let i = 0; i < 40 && locked < 0; i++) {
		const g = renderScene({ w: W, h: H, quad, t: i, seed: 7 + i, content: subtitled });
		if (pipe.update(feed.push({ light: g, plain: g })).state === LOCKED) locked = i;
	}
	assert.ok(locked >= 0, 'never locked');
	assert.ok(maxCornerError(pipe.quad, quad) < 4,
		`locked ${maxCornerError(pipe.quad, quad).toFixed(1)}px off - probably onto the subtitle strip`);
});

test('a still camera cannot inflate the outline through its own prediction', () => {
	const pipe = new ScreenPipeline(W, H);
	const step = bedroomStepper(pipe);
	for (let i = 0; i < 30; i++) step({ t: i, seed: 21 + i });
	assert.equal(pipe.state, LOCKED);
	// A burst of wobble injects velocity, then the camera is perfectly still.
	for (let i = 30; i < 50; i++) step({ t: i, seed: 21 + i, shake: 6 * Math.sin(i * 0.8) });
	const areas = [];
	for (let i = 50; i < 130; i++) {
		const out = step({ t: i, seed: 21 + i });
		if (out.state === LOCKED && out.quad) {
			const q = out.quad;
			areas.push(Math.abs((q[1][0] - q[0][0]) * (q[3][1] - q[0][1])));
		}
	}
	assert.ok(areas.length > 40, 'lost the lock outright after the wobble');
	const late = areas[areas.length - 1], early = areas[0];
	assert.ok(late < early * 1.5, `outline area grew ${(late / early).toFixed(1)}x with the camera still`);
	assert.ok(maxCornerError(pipe.quad, tablet) < 8, `ended ${maxCornerError(pipe.quad, tablet).toFixed(1)}px off`);
});

test('a lock survives 300 frames of 1px tremor without a single drop', () => {
	// Round-two fleet finding: the stray check executed a PERFECT lock at
	// frame 215 over its own edge-glow - compensation residuals hugging the
	// outline - and the re-lock landed 97px deep in the keyboard.
	const pipe = new ScreenPipeline(W, H);
	const step = bedroomStepper(pipe);
	let drops = 0, wasLocked = false;
	for (let i = 0; i < 300; i++) {
		const out = step({ t: i, seed: 21 + i, shake: 1.0 * Math.sin(i * 2.1) });
		if (wasLocked && out.state !== LOCKED) drops++;
		wasLocked = out.state === LOCKED;
	}
	assert.equal(drops, 0, `a steady lock was dropped ${drops} times under 1px tremor`);
	assert.equal(pipe.state, LOCKED);
	assert.ok(maxCornerError(pipe.quad, tablet) < 6, `ended ${maxCornerError(pipe.quad, tablet).toFixed(1)}px off`);
});

test('a hand-placed outline survives 300 frames of coarse tremor', () => {
	// Round-two fleet finding: an Adjust-seeded outline died at frame 38.
	const pipe = new ScreenPipeline(W, H);
	const step = bedroomStepper(pipe);
	step({ t: 0, seed: 21 });
	assert.ok(pipe.seed(tablet.map(([x, y], k) => [x + (k % 2 ? 3 : -3), y + (k < 2 ? -3 : 3)])));
	for (let i = 1; i <= 300; i++) {
		const out = step({ t: i, seed: 21 + i, shake: 2.5 * Math.sin(i * 2.1) });
		assert.equal(out.state, LOCKED, `hand-placed outline executed at frame ${i}`);
	}
	assert.ok(maxCornerError(pipe.quad, tablet) < 6, `drifted to ${maxCornerError(pipe.quad, tablet).toFixed(1)}px`);
});

test('a slow auto-exposure convergence neither kills the lock nor poisons the memories', () => {
	// Round-two fleet finding: a 1.2%/frame gain ramp slid under the absolute
	// global-change floor (dark pixels move less than any floor), fed the
	// stray check, killed the lock at frame 50, poisoned the film memory for
	// thousands of frames and left "zoom out" showing for five seconds.
	const pipe = new ScreenPipeline(W, H);
	const step = bedroomStepper(pipe);
	for (let i = 0; i < 40; i++) step({ t: i, seed: 21 + i });
	assert.equal(pipe.state, LOCKED);
	for (let i = 40; i < 180; i++) {
		const gain = i < 70 ? 1 + 0.012 * (i - 40) : 1.36;
		const out = step({ t: i, seed: 21 + i, gain });
		assert.equal(out.state, LOCKED, `slow AE ramp killed the lock at frame ${i}`);
		assert.ok(!out.clipped, `"zoom out" shown during/after the ramp at frame ${i}`);
	}
	assert.ok(maxCornerError(pipe.quad, tablet) < 6);
});

test('a paused film plus continuing tremor keeps the lock indefinitely', () => {
	// Round-two fleet finding: executed at frame 229 by tremor-lit wall
	// texture, with tracking at 1.8px the whole time. A paused film in a lit
	// room cannot be re-acquired, so that kill was permanent.
	const pipe = new ScreenPipeline(W, H);
	const step = bedroomStepper(pipe);
	for (let i = 0; i < 40; i++) step({ t: i, seed: 21 + i });
	assert.equal(pipe.state, LOCKED);
	for (let i = 40; i < 340; i++) {
		const out = step({ t: i, seed: 21 + i, paused: true, shake: 1.2 * Math.sin(i * 2.1) });
		assert.equal(out.state, LOCKED, `paused film + tremor lost the lock at frame ${i}`);
	}
	assert.ok(maxCornerError(pipe.quad, tablet) < 6);
});

test('after a pan the lock or a clean re-lock returns within a second of steadying', () => {
	// Round-two fleet finding: the smeared change memory took 28 frames to
	// decay below threshold, leaving the app blind for over a second after
	// the camera had already steadied.
	const pipe = new ScreenPipeline(W, H);
	const step = bedroomStepper(pipe);
	for (let i = 0; i < 40; i++) step({ t: i, seed: 21 + i });
	assert.equal(pipe.state, LOCKED);
	// A 40-frame pan sweeping forty pixels out and back (peak ~3px/frame),
	// then still with residual tremor.
	for (let i = 40; i < 80; i++) step({ t: i, seed: 21 + i, shake: 40 * Math.sin((i - 40) * Math.PI / 40) });
	let restored = -1;
	for (let i = 80; i < 200 && restored < 0; i++) {
		const out = step({ t: i, seed: 21 + i, shake: 0.5 * Math.sin(i) });
		if (out.state === LOCKED && maxCornerError(out.quad, tablet) < 8) restored = i - 80;
	}
	assert.ok(restored >= 0 && restored <= 35,
		restored < 0 ? 'never recovered after the pan' : `took ${restored} frames after steadying`);
});
