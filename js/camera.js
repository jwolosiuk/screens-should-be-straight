// Camera access and per-frame grayscale downsampling.

import { ChangeTracker, makeGray, rgbaToChannels } from './image.js';

export const CAMERA_ERRORS = {
	NotAllowedError: 'Camera permission was refused. Allow it in the address bar, then try again.',
	NotFoundError: 'No camera found on this device.',
	NotReadableError: 'The camera is already in use by another app.',
	OverconstrainedError: 'No camera matched the requested settings.',
	SecurityError: 'The browser blocked camera access on this page.',
};

export async function startCamera(video, { width = 1920, height = 1080 } = {}) {
	if (!navigator.mediaDevices?.getUserMedia) {
		throw new Error('This browser cannot open a camera (getUserMedia is missing).');
	}
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: false,
		video: {
			facingMode: { ideal: 'environment' },
			width: { ideal: width },
			height: { ideal: height },
		},
	});
	video.srcObject = stream;
	video.setAttribute('playsinline', '');
	video.muted = true;
	await video.play();
	// Metadata occasionally arrives after play() resolves.
	if (!video.videoWidth) {
		await new Promise((resolve) => video.addEventListener('loadedmetadata', resolve, { once: true }));
	}
	return stream;
}

// Optical or sensor zoom, where the camera offers it. This is a real
// magnification - more sensor pixels on the screen you are pointing at - which
// is the point: a screen across a room lands on a small patch of the sensor,
// and no amount of un-warping invents detail that was never captured. Not all
// browsers expose it (Safari does not), so the caller has to cope with null.
export function zoomRange(stream) {
	const track = stream?.getVideoTracks?.()[0];
	const zoom = track?.getCapabilities?.().zoom;
	if (!zoom || !(zoom.max > zoom.min)) return null;
	return {
		min: zoom.min,
		max: zoom.max,
		step: zoom.step || (zoom.max - zoom.min) / 100,
		value: track.getSettings?.().zoom ?? zoom.min,
	};
}

export async function applyZoom(stream, value) {
	const track = stream?.getVideoTracks?.()[0];
	if (!track) return null;
	await track.applyConstraints({ advanced: [{ zoom: value }] });
	return track.getSettings?.().zoom ?? value;
}

export function stopCamera(stream) {
	stream?.getTracks().forEach((track) => track.stop());
}

// Draws each frame into a small offscreen canvas and hands back one brightness
// byte per pixel. Everything downstream works at this size: a few hundred
// pixels across is plenty to locate an edge to a fraction of a pixel, and it
// keeps the whole analysis well inside a frame's time budget on a phone.
export class FrameSampler {
	constructor(videoWidth, videoHeight, targetWidth = 320) {
		const scale = Math.min(1, targetWidth / videoWidth);
		this.w = Math.max(80, Math.round(videoWidth * scale));
		this.h = Math.max(60, Math.round(videoHeight * scale));
		this.canvas = document.createElement('canvas');
		this.canvas.width = this.w;
		this.canvas.height = this.h;
		this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
		this.light = makeGray(this.w, this.h);
		this.plain = makeGray(this.w, this.h);
		// Change is measured against a reference from a few tenths of a second
		// ago (a slow scene moves too little frame-to-frame to clear the sensor
		// noise), warped by the camera's own estimated motion so hand tremor
		// does not light up the room's static edges. ChangeTracker owns all of
		// that, including refusing to answer on pans and exposure ramps.
		this.tracker = new ChangeTracker(this.w, this.h);
	}

	// One light frame, the change against the compensated reference (null when
	// it cannot be trusted this frame), and the camera's own motion in pixels.
	sample(video) {
		this.ctx.drawImage(video, 0, 0, this.w, this.h);
		const { data } = this.ctx.getImageData(0, 0, this.w, this.h);
		rgbaToChannels(data, this.w, this.h, this);
		const { change, motion } = this.tracker.push(this.plain);
		return { light: this.light, change, motion, restless: this.tracker.restlessness };
	}

	toNormalized(quad) {
		return quad.map(([x, y]) => [x / this.w, y / this.h]);
	}
}
