// Camera access and per-frame grayscale downsampling.

import { makeGray, rgbaToGray } from './image.js';

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

export function stopCamera(stream) {
	stream?.getTracks().forEach((track) => track.stop());
}

// Draws each frame into a small offscreen canvas and hands back one luminance
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
		this.gray = makeGray(this.w, this.h);
	}

	sample(video) {
		this.ctx.drawImage(video, 0, 0, this.w, this.h);
		const { data } = this.ctx.getImageData(0, 0, this.w, this.h);
		return rgbaToGray(data, this.w, this.h, this.gray);
	}

	toNormalized(quad) {
		return quad.map(([x, y]) => [x / this.w, y / this.h]);
	}

	fromNormalized(quad) {
		return quad.map(([x, y]) => [x * this.w, y * this.h]);
	}
}
