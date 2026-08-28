// The small camera view in the corner: what the phone actually sees, with the
// outline the app is tracking drawn over it. It is also the manual override -
// drag the four handles onto the screen and the tracker takes it from there.

export class Preview {
	constructor(canvas) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.sourceWidth = 1;
		this.sourceHeight = 1;
	}

	setSourceSize(w, h) {
		this.sourceWidth = w;
		this.sourceHeight = h;
		this.canvas.width = w;
		this.canvas.height = h;
	}

	// Pointer position (client coordinates) in source-image coordinates.
	toSource(clientX, clientY) {
		const rect = this.canvas.getBoundingClientRect();
		return [
			((clientX - rect.left) / rect.width) * this.sourceWidth,
			((clientY - rect.top) / rect.height) * this.sourceHeight,
		];
	}

	// How many source pixels one CSS pixel covers, so hit targets stay finger
	// sized whether the preview is a thumbnail or filling the screen.
	get scale() {
		const rect = this.canvas.getBoundingClientRect();
		return rect.width ? this.sourceWidth / rect.width : 1;
	}

	render(video, { outline = null, candidate = null, handles = null, dim = false } = {}) {
		const { ctx, canvas } = this;
		ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
		if (dim) {
			ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
		}
		if (candidate && !outline) this.strokeQuad(candidate, 'rgba(255, 255, 255, 0.55)', 2, [6, 5]);
		if (outline) this.strokeQuad(outline, '#5ad2a0', 3);
		if (handles) {
			this.strokeQuad(handles, '#ffd166', 3);
			const r = Math.max(8, 0.02 * this.sourceWidth);
			handles.forEach(([x, y], i) => {
				ctx.beginPath();
				ctx.arc(x, y, r, 0, Math.PI * 2);
				ctx.fillStyle = 'rgba(255, 209, 102, 0.9)';
				ctx.fill();
				ctx.fillStyle = '#1a1a1a';
				ctx.font = `${Math.round(r * 1.2)}px system-ui, sans-serif`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(String(i + 1), x, y);
			});
		}
	}

	strokeQuad(quad, colour, width, dash = null) {
		const { ctx } = this;
		ctx.save();
		ctx.beginPath();
		quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
		ctx.closePath();
		ctx.lineWidth = width * (this.sourceWidth / 320);
		ctx.strokeStyle = colour;
		if (dash) ctx.setLineDash(dash);
		ctx.stroke();
		ctx.restore();
	}
}
