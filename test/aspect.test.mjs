import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateAspect, focalFromFov } from '../js/aspect.js';
import { orderQuad } from '../js/geom.js';
import { projectRect } from './synth.mjs';

const principal = [160, 120];

test('recovers 16:9 from a strongly angled view, and the focal length with it', () => {
	const quad = orderQuad(projectRect({ aspect: 16 / 9, yaw: 0.6, pitch: 0.25, focal: 700, principal }));
	const est = estimateAspect(quad, { principal, focal: focalFromFov(320) });
	assert.ok(est);
	assert.equal(est.method, 'perspective');
	assert.ok(Math.abs(est.aspect - 16 / 9) / (16 / 9) < 0.02, `aspect ${est.aspect}`);
	assert.ok(Math.abs(est.focal - 700) / 700 < 0.05, `focal ${est.focal}`);
});

test('handles other real screen shapes', () => {
	for (const truth of [4 / 3, 16 / 10, 21 / 9, 9 / 16]) {
		const quad = orderQuad(projectRect({ aspect: truth, yaw: -0.45, pitch: 0.3, focal: 640, principal }));
		const est = estimateAspect(quad, { principal, focal: focalFromFov(320) });
		assert.ok(est, `no estimate for ${truth}`);
		assert.ok(Math.abs(est.aspect - truth) / truth < 0.03, `${truth} -> ${est.aspect}`);
	}
});

test('a near straight-on view falls back instead of dividing by nothing', () => {
	const quad = orderQuad(projectRect({ aspect: 16 / 9, yaw: 1e-7, pitch: 1e-7, focal: 700, principal }));
	const est = estimateAspect(quad, { principal, focal: focalFromFov(320) });
	assert.ok(est);
	assert.ok(Math.abs(est.aspect - 16 / 9) / (16 / 9) < 0.05, `aspect ${est.aspect} via ${est.method}`);
});

test('nonsense input is rejected', () => {
	assert.equal(estimateAspect(null), null);
	assert.equal(estimateAspect([[0, 0], [1, 0], [2, 0], [3, 0]]), null);
});
