// The gyroscope as a second opinion. Every pixel channel in this app can be
// argued with by a film large enough to fill the view; the gyroscope cannot,
// and what it buys is the one statement none of the others can make: the
// device did not move, so the room did not move, so whatever changed in that
// moment changed by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCKED, SEARCHING, ScreenPipeline } from '../js/pipeline.js';
import { MotionSensor } from '../js/motion-sensor.js';
import { rgbaToChannels } from '../js/image.js';
import { focalFromFov } from '../js/aspect.js';
import { ChangeFeed, orbitQuad, renderDaylightRoom } from './synth.mjs';

const W = 320, H = 255;
const maxCornerError = (found, truth) =>
	Math.max(...found.map((p, i) => Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1])));
const television = orbitQuad(0, { still: true }).map(([x, y]) => [88 + (x - 160) * 0.58, 88 + (y - 120) * 0.62]);
const shakeAt = (i, amplitude) => amplitude * Math.sin(i * 2.1);

// What a real gyroscope would report for a scene whose shake we know: the
// frame-to-frame image displacement, with a little noise, and no knowledge
// whatever of what is on the screen.
function sensorFor(i, amplitude, noise = 0.04) {
	const shift = Math.abs(shakeAt(i, amplitude) - shakeAt(i - 1, amplitude))
		+ (((i * 2654435761) % 1000) / 1000 - 0.5) * noise;
	return { shift: Math.max(0, shift), roll: 0, jolt: 0, still: shift < 0.3 };
}

function run({ amplitude, frames, withSensor, paused = false }) {
	const pipe = new ScreenPipeline(W, H);
	const feed = new ChangeFeed();
	let locked = -1, lockedFrames = 0;
	for (let i = 0; i < frames; i++) {
		const scene = renderDaylightRoom({
			w: W, h: H, picture: television, t: i, seed: 41 + i, paused,
			shake: shakeAt(i, amplitude),
		});
		const out = pipe.update(feed.push(rgbaToChannels(scene.rgba, W, H), withSensor ? sensorFor(i, amplitude) : null));
		if (out.state === LOCKED) {
			if (locked < 0) locked = i;
			lockedFrames++;
		}
	}
	return { pipe, locked, lockedFrames };
}

test('a gyroscope reading is optional: without one, nothing changes', () => {
	const withOut = run({ amplitude: 0.8, frames: 120, withSensor: false });
	assert.ok(withOut.locked >= 0, 'the pixel-only path must still work on its own');
	assert.equal(withOut.pipe.report().sensor, null, 'no sensor should be reported');
	assert.ok(maxCornerError(withOut.pipe.quad, television) < 8);
});

test('with a gyroscope, evidence is gathered only from the still moments', () => {
	const { pipe, locked } = run({ amplitude: 1.4, frames: 140, withSensor: true });
	assert.ok(locked >= 0, 'never locked with the sensor in play');
	assert.ok(pipe.stillFrames > 10,
		`a tremor crosses zero constantly; only ${pipe.stillFrames} frames were judged still`);
	assert.ok(maxCornerError(pipe.quad, television) < 8,
		`settled ${maxCornerError(pipe.quad, television).toFixed(1)}px from the set`);
});

test('the still map holds the film and not the room', () => {
	const { pipe } = run({ amplitude: 1.4, frames: 140, withSensor: true });
	assert.ok(pipe.stillActivity, 'no still map was built');
	const peak = pipe.stillActivity.peak;
	const inside = (x, y) => x > television[0][0] + 6 && x < television[1][0] - 6
		&& y > television[0][1] + 6 && y < television[3][1] - 6;
	let film = 0, room = 0;
	for (let y = 4; y < H - 4; y += 3) {
		for (let x = 4; x < W - 4; x += 3) {
			const v = peak[y * W + x];
			if (v < 12) continue;
			if (inside(x, y)) film++; else room++;
		}
	}
	assert.ok(film > 40, `the film should be all over the still map, found ${film} points`);
	// The radiator's fins and the set's own bezel are the loudest things in
	// the ordinary change map; while the phone is still they say nothing.
	assert.ok(room < film, `the room out-shouted the film in the still map (${room} vs ${film})`);
});

test('a paused film is either left alone or found correctly, never guessed at', () => {
	// A paused picture cannot be told from a poster by anything moving, so the
	// app is allowed to find nothing. What it may not do is invent a screen:
	// if it does lock, it has to have locked onto the set. (It usually does -
	// a shaking hand outlines the bezel in the change map, which is a real
	// edge of a real screen, unlike the fins of a radiator.)
	for (const withSensor of [true, false]) {
		const { pipe, lockedFrames } = run({ amplitude: 0.6, frames: 90, withSensor, paused: true });
		if (pipe.state === SEARCHING) {
			assert.equal(lockedFrames, 0, 'flapped in and out of a lock on a paused picture');
			continue;
		}
		assert.ok(maxCornerError(pipe.quad, television) < 10,
			`locked ${maxCornerError(pipe.quad, television).toFixed(1)}px from the set (sensor: ${withSensor})`);
	}
});

test('a gyroscope that reports nothing is treated as absent', () => {
	const sensor = new MotionSensor();
	assert.equal(sensor.read(focalFromFov(320)), null, 'no samples means no opinion');
	sensor.onMotion({ interval: 16, rotationRate: { alpha: null, beta: null, gamma: null } });
	assert.equal(sensor.read(focalFromFov(320)), null, 'a device reporting nulls has no gyroscope');
});

test('rotation is converted to image motion at the right scale', () => {
	const sensor = new MotionSensor();
	const focal = focalFromFov(320);
	// A tenth of a degree per frame of pitch, sampled twice at 30fps.
	for (let i = 0; i < 2; i++) sensor.onMotion({ interval: 16, rotationRate: { alpha: 0, beta: 3, gamma: 0 } });
	const reading = sensor.read(focal);
	assert.ok(reading, 'a reporting gyroscope should produce a reading');
	// 3 deg/s over 32ms is 0.096 degrees, which at this focal length is about
	// four tenths of a pixel - and that is NOT still: at a hard edge of 160
	// levels it would smear sixty levels of false change into the map.
	assert.ok(Math.abs(reading.shift - focal * 0.096 * Math.PI / 180) < 0.05,
		`shift ${reading.shift.toFixed(2)}px`);
	assert.equal(reading.still, false, 'four tenths of a pixel is not still');
	sensor.onMotion({ interval: 16, rotationRate: { alpha: 0, beta: 0.5, gamma: 0 } });
	assert.equal(sensor.read(focal).still, true, 'a twentieth of a pixel is still');
});
