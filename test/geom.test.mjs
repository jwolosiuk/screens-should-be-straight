import test from 'node:test';
import assert from 'node:assert/strict';
import {
	convexHull, fitLineRobust, inwardNormal, isConvex, lineIntersect,
	maxAreaQuad, orderQuad, quadArea, signedArea, simplifyPolygon,
} from '../js/geom.js';
import { prng } from './synth.mjs';

test('orderQuad puts corners in canonical order whatever order they arrive in', () => {
	const quad = [[10, 8], [90, 5], [95, 60], [6, 64]];
	for (const perm of [[2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]]) {
		const ordered = orderQuad(perm.map((i) => quad[i]));
		assert.deepEqual(ordered, quad);
		assert.ok(signedArea(ordered) > 0, 'canonical order has positive shoelace area');
	}
});

test('inward normal points into the quad', () => {
	const quad = [[10, 8], [90, 5], [95, 60], [6, 64]];
	const cx = 50.25, cy = 34.25;
	for (let e = 0; e < 4; e++) {
		const [nx, ny] = inwardNormal(quad, e);
		const mx = (quad[e][0] + quad[(e + 1) % 4][0]) / 2;
		const my = (quad[e][1] + quad[(e + 1) % 4][1]) / 2;
		assert.ok(nx * (cx - mx) + ny * (cy - my) > 0, `edge ${e} normal points outwards`);
	}
});

test('hull of a noisy pixel blob simplifies back to its four corners', () => {
	const quad = [[20, 15], [180, 10], [190, 120], [14, 128]];
	const pts = [];
	for (let t = 0; t <= 1; t += 0.01) {
		for (let e = 0; e < 4; e++) {
			const a = quad[e], b = quad[(e + 1) % 4];
			pts.push([Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t)]);
		}
	}
	const found = maxAreaQuad(simplifyPolygon(convexHull(pts), 2, 4));
	assert.ok(found);
	found.forEach((p, i) => {
		assert.ok(Math.hypot(p[0] - quad[i][0], p[1] - quad[i][1]) < 2.5, `corner ${i}: ${p}`);
	});
	assert.ok(isConvex(found));
	assert.ok(Math.abs(quadArea(found) - quadArea(quad)) / quadArea(quad) < 0.03);
});

test('line fit ignores a minority of outliers', () => {
	const rand = prng(3);
	const pts = [];
	for (let i = 0; i < 20; i++) pts.push([10 + i * 4, 50 + (rand() - 0.5) * 0.6]);
	for (let i = 0; i < 5; i++) pts.push([20 + i * 9, 50 + 18]);
	const fit = fitLineRobust(pts);
	assert.ok(fit);
	assert.ok(Math.abs(fit.line.a) < 0.05, 'recovered a horizontal line');
	assert.ok(Math.abs(-fit.line.c / fit.line.b - 50) < 0.5);
	assert.ok(fit.inliers.length >= 18 && fit.inliers.length <= 21);
});

test('lineIntersect returns null for parallel lines', () => {
	assert.equal(lineIntersect({ a: 0, b: 1, c: -5 }, { a: 0, b: 1, c: -9 }), null);
	const p = lineIntersect({ a: 0, b: 1, c: -5 }, { a: 1, b: 0, c: -3 });
	assert.deepEqual(p, [3, 5]);
});
