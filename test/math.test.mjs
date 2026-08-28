import test from 'node:test';
import assert from 'node:assert/strict';
import { mat3Apply, mat3Invert, mat3Mul, solveHomography, UNIT_SQUARE } from '../js/math.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);

test('homography maps the unit square onto the requested quad', () => {
	const quad = [[74, 62], [251, 44], [263, 183], [61, 171]];
	const H = solveHomography(UNIT_SQUARE, quad);
	assert.ok(H);
	UNIT_SQUARE.forEach((p, i) => {
		const [x, y] = mat3Apply(H, p[0], p[1]);
		near(x, quad[i][0], 1e-6);
		near(y, quad[i][1], 1e-6);
	});
});

test('inverse undoes the mapping', () => {
	const quad = [[74, 62], [251, 44], [263, 183], [61, 171]];
	const H = solveHomography(UNIT_SQUARE, quad);
	const Hinv = mat3Invert(H);
	const [u, v] = mat3Apply(Hinv, 160, 120);
	const [x, y] = mat3Apply(H, u, v);
	near(x, 160, 1e-6);
	near(y, 120, 1e-6);
	const I = mat3Mul(H, Hinv);
	for (let i = 0; i < 9; i++) near(I[i] / I[8], [1, 0, 0, 0, 1, 0, 0, 0, 1][i], 1e-9);
});

test('degenerate correspondences are rejected rather than returning nonsense', () => {
	const collinear = [[0, 0], [1, 1], [2, 2], [3, 3]];
	assert.equal(solveHomography(UNIT_SQUARE, collinear), null);
	assert.equal(mat3Invert([1, 2, 3, 2, 4, 6, 1, 1, 1]), null);
});
