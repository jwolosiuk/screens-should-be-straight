// Wiring: camera in, pipeline in the middle, warped picture out.

import { applyZoom, startCamera, stopCamera, zoomRange, CAMERA_ERRORS, FrameSampler } from './camera.js';
import { isConvex, orderQuad } from './geom.js';
import { LOCKED, ScreenPipeline } from './pipeline.js';
import { Preview } from './preview.js';
import { WarpRenderer } from './render.js';

const $ = (id) => document.getElementById(id);
const els = {
	intro: $('intro'), stage: $('stage'), video: $('camera'), output: $('output'),
	preview: $('preview'), hint: $('hint'), statsPanel: $('stats'), error: $('error'),
	adjustBar: $('adjust-bar'),
	start: $('btn-start'), rescan: $('btn-rescan'), previewToggle: $('btn-preview'), adjust: $('btn-adjust'),
	shape: $('btn-shape'), rotate: $('btn-rotate'), fullscreen: $('btn-fullscreen'),
	stats: $('btn-stats'), stop: $('btn-stop'), apply: $('adjust-apply'), cancel: $('adjust-cancel'),
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
	running: false, shape: 0, rotation: 'auto', wakeLock: null,
	adjusting: false, handles: null, dragging: -1,
	frames: 0, fps: 0, lastFpsAt: 0, lockedSince: 0,
	zoom: null, zoomBusy: false, zoomWanted: null, pinch: null,
	chrome: true, tap: null, previewHidden: false, flash: null, lastAnalysis: 0,
};

// A message that survives the per-frame hint rewrite for a moment. Writing to
// the hint directly lasts one video frame - updateHint overwrites it - so both
// "those corners don't work" and "no zoom on this camera" were shipped
// invisible.
function flash(text, ms = 2500) {
	app.flash = { text, until: performance.now() + ms };
}

// The camera thumbnail is the biggest thing sitting on top of the picture, so
// it gets its own toggle separate from tap-to-hide-everything. While adjusting
// it is the interaction surface and comes back regardless; the choice is
// restored when adjusting ends.
function applyPreviewVisibility() {
	els.preview.hidden = app.previewHidden && !app.adjusting;
	els.previewToggle.textContent = app.previewHidden ? 'Show preview' : 'Hide preview';
}

// Everything that is not the picture: controls, preview, hint, stats.
function setChrome(on) {
	app.chrome = on;
	els.stage.classList.toggle('chrome-hidden', !on);
}

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
		// One GL context per canvas for the life of the page: asking for another
		// hands back the same one, and re-linking the program on every restart
		// would just leak shaders into it.
		app.renderer ??= new WarpRenderer(els.output);
		app.preview = new Preview(els.preview);
		app.preview.setSourceSize(app.sampler.w, app.sampler.h);
		app.zoom = zoomRange(app.stream);
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
	setChrome(true);
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
		// iOS releases the lock on every app switch or pull-down, and a
		// released sentinel is still truthy - without this, the guard below
		// never re-requests and the phone dims mid-film.
		app.wakeLock?.addEventListener?.('release', () => { app.wakeLock = null; }, { once: true });
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

// Which way up to show the picture.
//
// The outline's corners are labelled from the camera frame, so turning the
// phone turns the screen within it and the un-warped picture comes out on its
// side. A cinema screen is wider than it is tall, so a portrait-shaped result
// means exactly that has happened; which way to turn it back is a question for
// the device, if it will say.
function effectiveRotation() {
	if (app.rotation !== 'auto') return app.rotation;
	const aspect = app.pipeline?.aspect;
	if (!aspect || aspect >= 1) return 0;
	return window.screen?.orientation?.angle === 270 ? 3 : 1;
}

function outputAspect() {
	const measured = SHAPES[app.shape].ratio ?? app.pipeline.aspect ?? 16 / 9;
	return effectiveRotation() % 2 ? 1 / measured : measured;
}

function frame(now = performance.now()) {
	if (!app.running) return;
	const { sampler, pipeline, renderer, preview } = app;
	// Analysis is tuned in per-frame units around 30fps; a 60fps camera
	// (requestVideoFrameCallback on many phones) would halve every window and
	// double every decay. Cap analysis near 30Hz and keep rendering at full
	// rate - the picture stays smooth, the arithmetic keeps its clock.
	if (now - app.lastAnalysis < 26) {
		renderer.resize(els.stage.clientWidth, els.stage.clientHeight, Math.min(window.devicePixelRatio || 1, 2));
		const held = app.lastResult;
		if (held && held.state === LOCKED && held.quad) {
			renderer.draw(els.video, rotateQuad(sampler.toNormalized(held.quad), effectiveRotation()), outputAspect());
		} else {
			renderer.draw(els.video, FULL_FRAME, els.video.videoWidth / els.video.videoHeight);
		}
		schedule();
		return;
	}
	app.lastAnalysis = now;
	const { light, change, motion } = sampler.sample(els.video);
	const result = pipeline.update(light, change, motion);

	renderer.resize(els.stage.clientWidth, els.stage.clientHeight, Math.min(window.devicePixelRatio || 1, 2));
	if (result.state === LOCKED && result.quad) {
		const quad = rotateQuad(sampler.toNormalized(result.quad), effectiveRotation());
		renderer.draw(els.video, quad, outputAspect());
	} else {
		// Nothing found yet: show the camera as it is, so the user can aim.
		renderer.draw(els.video, FULL_FRAME, els.video.videoWidth / els.video.videoHeight);
	}

	if (!els.preview.hidden) {
		preview.render(els.video, {
			outline: app.adjusting ? null : result.quad,
			candidate: result.candidate,
			handles: app.adjusting ? app.handles : null,
			dim: app.adjusting,
		});
	}

	app.lastResult = result;
	updateHint(result, now);
	updateStats(result, now);
	schedule();
}

function updateHint(result, now) {
	if (app.flash) {
		if (now < app.flash.until) { els.hint.textContent = app.flash.text; return; }
		app.flash = null;
	}
	if (app.adjusting) { els.hint.textContent = ''; return; }
	if (result.state !== LOCKED) {
		app.lockedSince = 0;
		// "Clipped" means a playing picture demonstrably runs off the side of
		// the view. Nothing in the frame can say where its corners are, and the
		// fix is one the user can act on. After a while of finding nothing, say
		// what always works instead of letting the search spin silently.
		els.hint.textContent = result.clipped
			? 'Zoom out until the whole screen is in view'
			: result.searchFrames > 150
				? 'Can\u2019t find it? Tap Adjust and drag the corners onto the screen'
				: result.candidate ? 'Hold still\u2026' : 'Point the camera at the screen';
		return;
	}
	if (result.coasting) {
		els.hint.textContent = result.blind
			? 'No edge of the screen in view - zoom out a little'
			: 'Lost it for a moment…';
		return;
	}
	if (!app.lockedSince) app.lockedSince = now;
	// Say so once, then get out of the way.
	els.hint.textContent = now - app.lockedSince < 2400
		? 'Got it - move freely. Tap the picture to hide the buttons' : '';
}

function updateStats(result, now) {
	app.frames++;
	if (now - app.lastFpsAt > 500) {
		app.fps = Math.round((app.frames * 1000) / (now - app.lastFpsAt));
		app.frames = 0;
		app.lastFpsAt = now;
	}
	if (els.statsPanel.hidden) return;
	const aspect = app.pipeline.aspect;
	els.statsPanel.textContent = [
		`state      ${result.state}${result.coasting ? ' (coasting)' : ''}`,
		`found via  ${result.source ?? '-'}`,
		`restless   ${result.restless?.toFixed(1) ?? '-'}`,
		`confidence ${result.confidence.toFixed(2)}`,
		`aspect     ${aspect ? aspect.toFixed(3) : '-'} (${app.pipeline.aspectMethod ?? '-'})`,
		`edges seen ${result.edges}/4${result.blind ? ` (blind ${result.blind})` : ''}`,
		`zoom       ${app.zoom ? `${app.zoom.value.toFixed(1)}x of ${app.zoom.max}x` : 'not offered by this camera'}`,
		`rotation   ${app.rotation === 'auto' ? `auto (${effectiveRotation() * 90}°)` : `${app.rotation * 90}°`}`,
		`re-seeds   ${result.slips}`,
		`analysis   ${app.sampler.w}x${app.sampler.h} from ${els.video.videoWidth}x${els.video.videoHeight}`,
		`fps        ${app.fps}`,
	].join('\n');
}

/* Pinch to zoom. */

const pinchDistance = () => {
	const [a, b] = [...app.pinch.points.values()];
	return Math.hypot(a.x - b.x, a.y - b.y);
};

// applyConstraints is asynchronous and the camera takes a moment to settle, so
// pinch events are collapsed: remember the latest target and apply it when the
// previous change has landed.
async function pushZoom() {
	if (app.zoomBusy || app.zoomWanted === null || !app.zoom) return;
	app.zoomBusy = true;
	const wanted = app.zoomWanted;
	app.zoomWanted = null;
	try {
		app.zoom.value = await applyZoom(app.stream, wanted) ?? wanted;
	} catch {
		// Some cameras advertise a range and then refuse parts of it.
		app.zoom = zoomRange(app.stream);
	}
	app.zoomBusy = false;
	if (app.zoomWanted !== null) pushZoom();
}

function onStagePointerDown(event) {
	if (app.adjusting) return;
	app.pinch ??= { points: new Map(), distance: 0, from: 0 };
	app.pinch.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
	if (app.pinch.points.size === 1) {
		app.tap = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() };
	} else {
		// A second finger means a pinch, not a tap.
		app.tap = null;
	}
	if (app.pinch.points.size === 2) {
		app.pinch.distance = pinchDistance();
		app.pinch.from = app.zoom ? app.zoom.value : 1;
		if (!app.zoom) flash('This camera does not offer zoom to the browser - move closer instead');
	}
}

function onStagePointerMove(event) {
	if (!app.pinch?.points.has(event.pointerId)) return;
	app.pinch.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
	if (app.pinch.points.size !== 2 || !app.zoom || app.pinch.distance <= 0) return;
	const scale = pinchDistance() / app.pinch.distance;
	const { min, max } = app.zoom;
	app.zoomWanted = Math.min(max, Math.max(min, app.pinch.from * scale));
	pushZoom();
}

function onStagePointerUp(event) {
	app.pinch?.points.delete(event.pointerId);
	// A short single-finger touch that went nowhere: toggle the panels.
	const tap = app.tap;
	if (tap && tap.id === event.pointerId) {
		app.tap = null;
		const moved = Math.hypot(event.clientX - tap.x, event.clientY - tap.y);
		if (moved < 8 && performance.now() - tap.at < 400) setChrome(!app.chrome);
	}
}

/* Manual placement of the corners. */

function setAdjusting(on) {
	app.adjusting = on;
	els.preview.classList.toggle('adjusting', on);
	applyPreviewVisibility();
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
	els.preview.setPointerCapture?.(event.pointerId);
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
		flash('Those four corners do not make a screen - try again');
		return;
	}
	setAdjusting(false);
}

/* Controls */

els.start.addEventListener('click', start);
els.stop.addEventListener('click', stop);
els.rescan.addEventListener('click', () => { setAdjusting(false); app.pipeline?.reset(); });
els.previewToggle.addEventListener('click', () => {
	app.previewHidden = !app.previewHidden;
	applyPreviewVisibility();
});
els.adjust.addEventListener('click', () => setAdjusting(!app.adjusting));
els.apply.addEventListener('click', applyHandles);
els.cancel.addEventListener('click', () => setAdjusting(false));
els.shape.addEventListener('click', () => {
	app.shape = (app.shape + 1) % SHAPES.length;
	els.shape.textContent = `Shape: ${SHAPES[app.shape].label}`;
});
const ROTATIONS = ['auto', 0, 1, 2, 3];
els.rotate.addEventListener('click', () => {
	const next = ROTATIONS[(ROTATIONS.indexOf(app.rotation) + 1) % ROTATIONS.length];
	app.rotation = next;
	els.rotate.textContent = next === 'auto' ? 'Rotate: auto' : `Rotate: ${next * 90}°`;
});
els.fullscreen.addEventListener('click', () => {
	if (document.fullscreenElement) document.exitFullscreen();
	else document.documentElement.requestFullscreen?.().catch(() => {});
});
els.stats.addEventListener('click', () => { els.statsPanel.hidden = !els.statsPanel.hidden; });
els.preview.addEventListener('pointerdown', onPointerDown);
els.preview.addEventListener('pointermove', onPointerMove);
els.preview.addEventListener('pointerup', onPointerUp);
els.preview.addEventListener('pointercancel', onPointerUp);
els.output.addEventListener('pointerdown', onStagePointerDown);
els.output.addEventListener('pointermove', onStagePointerMove);
els.output.addEventListener('pointerup', onStagePointerUp);
els.output.addEventListener('pointercancel', onStagePointerUp);

// Losing the GL context (backgrounded app, driver reset) leaves a canvas that
// silently draws nothing, which would look like the tracker breaking.
els.output.addEventListener('webglcontextlost', (event) => {
	event.preventDefault();
	stop();
	fail('The graphics context was lost. Start the camera again.');
});

if (!document.documentElement.requestFullscreen) els.fullscreen.hidden = true;
if (!window.isSecureContext) {
	fail('Camera access needs a secure connection (https). This page was loaded over plain http.');
}
