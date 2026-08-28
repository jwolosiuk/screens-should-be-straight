// Wiring: camera in, pipeline in the middle, warped picture out.

import { startCamera, stopCamera, CAMERA_ERRORS, FrameSampler } from './camera.js';
import { isConvex, orderQuad } from './geom.js';
import { LOCKED, ScreenPipeline } from './pipeline.js';
import { Preview } from './preview.js';
import { WarpRenderer } from './render.js';

const $ = (id) => document.getElementById(id);
const els = {
	intro: $('intro'), stage: $('stage'), video: $('camera'), output: $('output'),
	preview: $('preview'), hint: $('hint'), stats: $('stats'), error: $('error'),
	adjustBar: $('adjust-bar'),
	start: $('btn-start'), rescan: $('btn-rescan'), adjust: $('btn-adjust'),
	shape: $('btn-shape'), rotate: $('btn-rotate'), fullscreen: $('btn-fullscreen'),
	stop: $('btn-stop'), apply: $('adjust-apply'), cancel: $('adjust-cancel'),
};

const SHAPES = [
	{ label: 'auto', ratio: null },
	{ label: '16:9', ratio: 16 / 9 },
	{ label: '4:3', ratio: 4 / 3 },
	{ label: '21:9', ratio: 21 / 9 },
];
const FULL_FRAME = [[0, 0], [1, 0], [1, 1], [0, 1]];

const app = {
	stream: null, sampler: null, pipeline: null, renderer: null, preview: null,
	running: false, shape: 0, rotation: 0, wakeLock: null,
	adjusting: false, handles: null, dragging: -1,
	frames: 0, fps: 0, lastFpsAt: 0, lockedSince: 0,
};

function fail(message) {
	els.error.textContent = message;
	els.error.hidden = false;
}

async function start() {
	els.error.hidden = true;
	els.start.disabled = true;
	els.start.textContent = 'Starting…';
	try {
		app.stream = await startCamera(els.video);
		app.sampler = new FrameSampler(els.video.videoWidth, els.video.videoHeight);
		app.pipeline = new ScreenPipeline(app.sampler.w, app.sampler.h);
		app.renderer = new WarpRenderer(els.output);
		app.preview = new Preview(els.preview);
		app.preview.setSourceSize(app.sampler.w, app.sampler.h);
	} catch (err) {
		stopCamera(app.stream);
		app.stream = null;
		fail(CAMERA_ERRORS[err.name] ?? err.message ?? String(err));
		els.start.disabled = false;
		els.start.textContent = 'Start the camera';
		return;
	}
	els.intro.hidden = true;
	els.stage.hidden = false;
	app.running = true;
	keepAwake();
	schedule();
}

function stop() {
	app.running = false;
	setAdjusting(false);
	stopCamera(app.stream);
	app.stream = null;
	app.wakeLock?.release?.().catch(() => {});
	app.wakeLock = null;
	els.stage.hidden = true;
	els.intro.hidden = false;
	els.start.disabled = false;
	els.start.textContent = 'Start the camera';
}

// Phones dim and lock the screen after a while of no touches, which is exactly
// what happens when you are holding one up watching a film through it.
async function keepAwake() {
	try {
		app.wakeLock = await navigator.wakeLock?.request('screen');
	} catch { /* not fatal, and not supported everywhere */ }
}
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible' && app.running && !app.wakeLock) keepAwake();
});

function schedule() {
	if (!app.running) return;
	if (els.video.requestVideoFrameCallback) els.video.requestVideoFrameCallback(frame);
	else requestAnimationFrame(frame);
}

const rotateQuad = (quad, k) => quad.slice(k).concat(quad.slice(0, k));

function outputAspect(quad) {
	const fixed = SHAPES[app.shape].ratio;
	const measured = fixed ?? app.pipeline.aspect ?? els.video.videoWidth / els.video.videoHeight;
	return app.rotation % 2 ? 1 / measured : measured;
}

function frame(now = performance.now()) {
	if (!app.running) return;
	const { sampler, pipeline, renderer, preview } = app;
	const gray = sampler.sample(els.video);
	const result = pipeline.update(gray);

	renderer.resize(els.stage.clientWidth, els.stage.clientHeight, Math.min(window.devicePixelRatio || 1, 2));
	if (result.state === LOCKED && result.quad) {
		const quad = rotateQuad(sampler.toNormalized(result.quad), app.rotation);
		renderer.draw(els.video, quad, outputAspect(result.quad));
	} else {
		// Nothing found yet: show the camera as it is, so the user can aim.
		renderer.draw(els.video, FULL_FRAME, els.video.videoWidth / els.video.videoHeight);
	}

	preview.render(els.video, {
		outline: app.adjusting ? null : result.quad,
		candidate: result.candidate,
		handles: app.adjusting ? app.handles : null,
		dim: app.adjusting,
	});

	updateHint(result, now);
	updateStats(result, now);
	schedule();
}

function updateHint(result, now) {
	if (app.adjusting) { els.hint.textContent = ''; return; }
	if (result.state !== LOCKED) {
		app.lockedSince = 0;
		els.hint.textContent = result.candidate
			? 'Hold still…'
			: 'Point the camera at the screen';
		return;
	}
	if (result.coasting) { els.hint.textContent = 'Lost it for a moment…'; return; }
	if (!app.lockedSince) app.lockedSince = now;
	// Say so once, then get out of the way.
	els.hint.textContent = now - app.lockedSince < 1600 ? 'Got it - move freely' : '';
}

function updateStats(result, now) {
	app.frames++;
	if (now - app.lastFpsAt > 500) {
		app.fps = Math.round((app.frames * 1000) / (now - app.lastFpsAt));
		app.frames = 0;
		app.lastFpsAt = now;
	}
	if (els.stats.hidden) return;
	const aspect = app.pipeline.aspect;
	els.stats.textContent = [
		`state      ${result.state}${result.coasting ? ' (coasting)' : ''}`,
		`confidence ${result.confidence.toFixed(2)}`,
		`aspect     ${aspect ? aspect.toFixed(3) : '-'} (${app.pipeline.aspectMethod ?? '-'})`,
		`analysis   ${app.sampler.w}x${app.sampler.h} from ${els.video.videoWidth}x${els.video.videoHeight}`,
		`fps        ${app.fps}`,
	].join('\n');
}

/* Manual placement of the corners. */

function setAdjusting(on) {
	app.adjusting = on;
	els.preview.classList.toggle('adjusting', on);
	els.adjustBar.hidden = !on;
	els.adjust.textContent = on ? 'Adjusting…' : 'Adjust';
	if (on) {
		const { w, h } = app.sampler;
		app.handles = (app.pipeline.quad ?? [
			[w * 0.2, h * 0.25], [w * 0.8, h * 0.25], [w * 0.8, h * 0.75], [w * 0.2, h * 0.75],
		]).map(([x, y]) => [x, y]);
	} else {
		app.handles = null;
		app.dragging = -1;
	}
}

function onPointerDown(event) {
	if (!app.adjusting) return;
	const [x, y] = app.preview.toSource(event.clientX, event.clientY);
	const reach = 26 * app.preview.scale;
	let best = -1, bestDistance = reach;
	app.handles.forEach(([hx, hy], i) => {
		const d = Math.hypot(hx - x, hy - y);
		if (d < bestDistance) { bestDistance = d; best = i; }
	});
	if (best < 0) return;
	app.dragging = best;
	els.preview.setPointerCapture(event.pointerId);
	event.preventDefault();
}

function onPointerMove(event) {
	if (app.dragging < 0) return;
	const [x, y] = app.preview.toSource(event.clientX, event.clientY);
	const { w, h } = app.sampler;
	app.handles[app.dragging] = [
		Math.max(-w * 0.2, Math.min(w * 1.2, x)),
		Math.max(-h * 0.2, Math.min(h * 1.2, y)),
	];
	event.preventDefault();
}

function onPointerUp(event) {
	if (app.dragging < 0) return;
	app.dragging = -1;
	els.preview.releasePointerCapture?.(event.pointerId);
}

function applyHandles() {
	const quad = orderQuad(app.handles);
	if (!isConvex(quad) || !app.pipeline.seed(quad)) {
		els.hint.textContent = 'Those corners cross over each other - try again';
		return;
	}
	setAdjusting(false);
}

/* Controls */

els.start.addEventListener('click', start);
els.stop.addEventListener('click', stop);
els.rescan.addEventListener('click', () => { setAdjusting(false); app.pipeline?.reset(); });
els.adjust.addEventListener('click', () => setAdjusting(!app.adjusting));
els.apply.addEventListener('click', applyHandles);
els.cancel.addEventListener('click', () => setAdjusting(false));
els.shape.addEventListener('click', () => {
	app.shape = (app.shape + 1) % SHAPES.length;
	els.shape.textContent = `Shape: ${SHAPES[app.shape].label}`;
});
els.rotate.addEventListener('click', () => { app.rotation = (app.rotation + 1) % 4; });
els.fullscreen.addEventListener('click', () => {
	if (document.fullscreenElement) document.exitFullscreen();
	else document.documentElement.requestFullscreen?.().catch(() => {});
});
els.hint.addEventListener('click', () => { els.stats.hidden = !els.stats.hidden; });
els.preview.addEventListener('pointerdown', onPointerDown);
els.preview.addEventListener('pointermove', onPointerMove);
els.preview.addEventListener('pointerup', onPointerUp);
els.preview.addEventListener('pointercancel', onPointerUp);

if (!document.documentElement.requestFullscreen) els.fullscreen.hidden = true;
if (!window.isSecureContext) {
	fail('Camera access needs a secure connection (https). This page was loaded over plain http.');
}
