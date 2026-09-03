// The phone's own gyroscope, as a second opinion about camera motion.
//
// Everything else in this app infers camera motion from pixels, and pixels can
// be argued with: a film that pans fills most of the view with content moving
// in one direction, and a block-matcher asked "how did the picture move" will
// answer honestly about the wrong thing. The gyroscope cannot be fooled by
// anything on a screen. That gives the one discriminator the pixel channels
// could never supply on their own - when the device reports that it did not
// move, the room cannot have moved either, so anything that changed in that
// moment changed by itself, which is what a screen does and a wall does not.
//
// Rotation is what matters at arm's length: a tenth of a degree of wrist
// rotation shifts the image by about half a pixel, while a tenth of a
// millimetre of translation shifts it by nothing measurable. Acceleration is
// read too, but only as a second vote on stillness - integrating it into a
// position is a well-known way to accumulate nonsense.

const DEG = Math.PI / 180;

export class MotionSensor {
	constructor() {
		this.available = false;
		this.pitch = 0;
		this.yaw = 0;
		this.roll = 0;
		this.samples = 0;
		this.jolt = 0;
		this.lastAcceleration = null;
		this.onMotion = this.onMotion.bind(this);
	}

	// Must be called from inside a user gesture on iOS, and before any await:
	// the permission prompt is only allowed while the gesture is still live.
	static async request() {
		if (typeof DeviceMotionEvent === 'undefined') return false;
		if (typeof DeviceMotionEvent.requestPermission !== 'function') return true;
		try {
			return (await DeviceMotionEvent.requestPermission()) === 'granted';
		} catch {
			return false;
		}
	}

	start() {
		if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') return false;
		window.addEventListener('devicemotion', this.onMotion);
		return true;
	}

	stop() {
		if (typeof window !== 'undefined') window.removeEventListener('devicemotion', this.onMotion);
		this.available = false;
	}

	onMotion(event) {
		const dt = (event.interval || 16) / 1000;
		const rate = event.rotationRate;
		if (rate && (rate.alpha !== null || rate.beta !== null || rate.gamma !== null)) {
			this.available = true;
			// beta turns the phone about its short axis, which slides the image
			// up and down; gamma slides it sideways; alpha spins it.
			this.pitch += (rate.beta || 0) * dt;
			this.yaw += (rate.gamma || 0) * dt;
			this.roll += (rate.alpha || 0) * dt;
			this.samples++;
		}
		const a = event.accelerationIncludingGravity;
		if (a && a.x !== null) {
			if (this.lastAcceleration) {
				const [px, py, pz] = this.lastAcceleration;
				this.jolt = Math.max(this.jolt, Math.hypot(a.x - px, a.y - py, a.z - pz));
			}
			this.lastAcceleration = [a.x, a.y, a.z];
		}
	}

	/**
	 * Consume everything accumulated since the last read.
	 * @param {number} focalPx camera focal length in analysis pixels
	 * @returns {{shift:number, roll:number, jolt:number, still:boolean}|null}
	 *   null when no gyroscope has reported, so callers fall back to pixels.
	 */
	read(focalPx) {
		if (!this.available || !this.samples) return null;
		const shift = focalPx * Math.hypot(this.pitch * DEG, this.yaw * DEG);
		const roll = this.roll * DEG;
		const jolt = this.jolt;
		this.pitch = this.yaw = this.roll = 0;
		this.samples = 0;
		this.jolt = 0;
		// Held still, not put down: a hand at rest still trembles, so the bar
		// is "moved less than a third of a pixel", not "moved nothing".
		return { shift, roll, jolt, still: shift < 0.3 && jolt < 0.35 };
	}
}
