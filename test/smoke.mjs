// The whole app, driven in jsdom against synthetic camera frames.
//
// The unit tests cover the geometry; this one covers the wiring around it -
// sampling the video, normalising the outline, and the matrix that finally
// reaches WebGL. That matrix is the app's actual output, so it is what gets
// checked: pushed through it, the corners of the output rectangle must land on
// the corners of the screen in the camera frame.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The adjust bar once shipped permanently visible: .adjust-bar { display:flex }
// outranks the browser's [hidden] { display:none }. The stylesheet must carry
// its own guard, and jsdom does not apply CSS, so the file itself is checked.
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
assert.match(css, /\[hidden\][^}]*display:\s*none\s*!important/,
	'styles.css must keep the [hidden] { display: none !important } guard');
import { JSDOM } from 'jsdom';
import { mat3Apply } from '../js/math.js';
import { UNIT_SQUARE } from '../js/math.js';
import { orbitQuad, renderScene } from './synth.mjs';

const VIDEO_W = 640, VIDEO_H = 480;
const state = { gray: null, matrix: null, draws: 0 };

const dom = new JSDOM(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), {
	pretendToBeVisual: true,
	url: 'https://example.test/',
});
const { window } = dom;
const { document } = window;

// Canvas: a 2D context that hands back whatever synthetic frame is current,
// and a WebGL context that records what it was asked to draw.
const fakeGl = new Proxy({
	getShaderParameter: () => true,
	getProgramParameter: () => true,
	getShaderInfoLog: () => '',
	getProgramInfoLog: () => '',
	getUniformLocation: () => ({}),
	getAttribLocation: () => 0,
	createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}), createTexture: () => ({}),
	uniformMatrix3fv: (_loc, _transpose, value) => { state.matrix = Array.from(value); },
	drawArrays: () => { state.draws++; },
}, {
	get: (target, prop) => (prop in target ? target[prop] : () => 1),
});

function fake2d(canvas) {
	return {
		canvas,
		drawImage() {},
		fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
		stroke() {}, fill() {}, arc() {}, save() {}, restore() {}, setLineDash() {}, fillText() {},
		getImageData(_x, _y, w, h) {
			assert.equal(w, state.gray.w, 'sampler size should match the synthetic frames');
			assert.equal(h, state.gray.h);
			const data = new Uint8ClampedArray(w * h * 4);
			for (let i = 0; i < w * h; i++) {
				data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = state.gray.data[i];
				data[i * 4 + 3] = 255;
			}
			return { data, width: w, height: h };
		},
	};
}
window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
	return kind === '2d' ? fake2d(this) : fakeGl;
};

const video = document.getElementById('camera');
Object.defineProperty(video, 'videoWidth', { get: () => VIDEO_W });
Object.defineProperty(video, 'videoHeight', { get: () => VIDEO_H });
video.play = async () => {};
// A camera that offers zoom, so the pinch path has something real to drive.
const track = {
	stop() {},
	settings: { zoom: 1 },
	getCapabilities: () => ({ zoom: { min: 1, max: 5, step: 0.1 } }),
	getSettings() { return this.settings; },
	async applyConstraints(constraints) {
		this.settings = { ...this.settings, ...constraints.advanced[0] };
	},
};
const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
window.navigator.mediaDevices = { getUserMedia: async () => stream };
window.isSecureContext = true;

// Hand the animation loop over to the test: one frame per call, no timers.
let pending = null;
window.requestAnimationFrame = (cb) => { pending = cb; return 1; };

// The app reaches for these as globals, the way it would in a browser.
// node defines its own read-only `navigator`, hence defineProperty.
for (const key of ['window', 'document', 'navigator', 'HTMLCanvasElement', 'requestAnimationFrame', 'devicePixelRatio']) {
	Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}

await import('../js/app.js');

const setFrame = (quad, t, still = false) => {
	state.gray = renderScene({ w: 320, h: 240, quad, t, seed: 7 + t });
	return quad;
};
// A clock that advances ~one video frame per tick: the app caps analysis at
// ~38Hz by wall time, and synchronous ticks sharing a timestamp would all take
// the render-only path, never re-running the pipeline or the hints.
let mockNow = performance.now();
const tick = () => {
	assert.ok(pending, 'the app stopped asking for frames');
	const cb = pending;
	pending = null;
	mockNow += 33;
	cb(mockNow);
};

// Start: the click has to come from a user gesture in a real browser, which is
// why the app has a start button at all.
setFrame(orbitQuad(0, { still: true }), 0);
document.getElementById('btn-start').click();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(document.getElementById('intro').hidden, true, 'intro should be out of the way');
assert.equal(document.getElementById('stage').hidden, false);

// Hold still until it locks on.
let locked = false;
for (let i = 0; i < 20 && !locked; i++) {
	setFrame(orbitQuad(0, { still: true }), i);
	tick();
	locked = document.getElementById('hint').textContent.startsWith('Got it');
}
assert.ok(locked, 'never locked on to the synthetic screen');
assert.ok(state.draws > 0, 'nothing was drawn');

// The matrix maps the output rectangle onto the screen in the frame.
function cornersFromMatrix() {
	assert.ok(state.matrix, 'no matrix was uploaded');
	const m = state.matrix; // column-major as uploaded
	const H = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
	return UNIT_SQUARE.map(([u, v]) => {
		const [x, y] = mat3Apply(H, u, v);
		return [x * 320, y * 240];
	});
}
const truth = orbitQuad(0, { still: true });
cornersFromMatrix().forEach((p, i) => {
	const d = Math.hypot(p[0] - truth[i][0], p[1] - truth[i][1]);
	assert.ok(d < 5, `corner ${i} of the warp is ${d.toFixed(1)}px off`);
});

// Now move the camera: the lock has to survive, and the matrix has to follow.
for (let i = 1; i <= 90; i++) {
	setFrame(orbitQuad(i), i);
	tick();
	assert.ok(!document.getElementById('hint').textContent.startsWith('Point'), `lost the screen at frame ${i}`);
}
const moved = orbitQuad(90);
cornersFromMatrix().forEach((p, i) => {
	const d = Math.hypot(p[0] - moved[i][0], p[1] - moved[i][1]);
	assert.ok(d < 6, `after moving, corner ${i} is ${d.toFixed(1)}px off`);
});

// Pinch on the output: two fingers moving apart should drive the camera's own
// zoom, not the browser's.
function pointer(type, id, x, y) {
	const event = new window.Event(type, { bubbles: true });
	Object.assign(event, { pointerId: id, clientX: x, clientY: y });
	document.getElementById('output').dispatchEvent(event);
}
pointer('pointerdown', 1, 100, 100);
pointer('pointerdown', 2, 200, 100);
pointer('pointermove', 2, 300, 100);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.ok(track.settings.zoom > 1.9 && track.settings.zoom < 2.1,
	`spreading the fingers by 2x should ask the camera for 2x zoom, got ${track.settings.zoom}`);
pointer('pointerup', 1, 100, 100);
pointer('pointerup', 2, 300, 100);

// A short single tap on the picture hides every panel; another brings them
// back; a pinch is not a tap.
const stage = document.getElementById('stage');
pointer('pointerdown', 5, 150, 150);
pointer('pointerup', 5, 151, 150);
assert.ok(stage.classList.contains('chrome-hidden'), 'a tap should hide the controls');
pointer('pointerdown', 6, 150, 150);
pointer('pointerup', 6, 150, 151);
assert.ok(!stage.classList.contains('chrome-hidden'), 'a second tap should bring them back');
pointer('pointerdown', 7, 100, 100);
pointer('pointerdown', 8, 200, 100);
pointer('pointerup', 7, 100, 100);
pointer('pointerup', 8, 200, 100);
assert.ok(!stage.classList.contains('chrome-hidden'), 'a pinch must not toggle the controls');

// The camera thumbnail has its own toggle, and adjusting overrides it: the
// preview is the surface the corner handles live on.
const previewEl = document.getElementById('preview');
const previewBtn = document.getElementById('btn-preview');
previewBtn.click();
assert.ok(previewEl.hidden, 'Hide preview should hide the thumbnail');
assert.equal(previewBtn.textContent, 'Show preview');
document.getElementById('btn-adjust').click();
assert.ok(!previewEl.hidden, 'adjusting must bring the preview back');
document.getElementById('adjust-cancel').click();
assert.ok(previewEl.hidden, 'the choice returns when adjusting ends');
previewBtn.click();
assert.ok(!previewEl.hidden, 'Show preview should bring it back');

// Controls: shape, rotation, manual placement, re-scan.
const shape = document.getElementById('btn-shape');
shape.click();
assert.equal(shape.textContent, 'Shape: 16:9');
const rotate = document.getElementById('btn-rotate');
assert.equal(rotate.textContent, 'Rotate: auto');
rotate.click();
assert.equal(rotate.textContent, 'Rotate: 0°', 'rotation should cycle out of auto into fixed steps');
tick();
assert.ok(state.draws > 0);

document.getElementById('btn-adjust').click();
assert.equal(document.getElementById('adjust-bar').hidden, false, 'adjust bar should appear');
tick();
document.getElementById('adjust-apply').click();
assert.equal(document.getElementById('adjust-bar').hidden, true, 'adjust bar should close on apply');

document.getElementById('btn-rescan').click();
setFrame(orbitQuad(0, { still: true }), 0);
tick();
assert.ok(
	['Point the camera at the screen', 'Hold still…'].includes(document.getElementById('hint').textContent),
	`re-scan should go back to searching, hint was "${document.getElementById('hint').textContent}"`,
);

document.getElementById('btn-stop').click();
assert.equal(document.getElementById('stage').hidden, true, 'stopping should return to the intro');

console.log('smoke: app locked on, followed 90 frames of motion and drove the controls');
