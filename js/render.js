// WebGL renderer for the un-warp.
//
// The perspective correction happens per pixel in the fragment shader: for
// every point of the output rectangle, the inverse homography says where to
// read from in the camera frame. A 2D canvas cannot do this at all - its
// transforms are affine, which is exactly the class of transform that cannot
// represent a change of viewpoint - so this is the one part of the app that
// genuinely needs GL.

import { UNIT_SQUARE, solveHomography } from './math.js';

const VERTEX_SHADER = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
	vUV = aPos;
	gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
}`;

// Texture coordinates come out of a division per pixel, so precision here is
// not cosmetic: at mediump (about three decimal digits) the sampling point
// drifts by a pixel or two across a large output and the picture crawls.
// highp is near-universal on phone GPUs now, but WebGL1 does not guarantee it
// in fragment shaders, hence the check.
const FRAGMENT_SHADER = (precision) => `
precision ${precision} float;
uniform sampler2D uTex;
uniform mat3 uH;
varying vec2 vUV;
void main() {
	vec3 p = uH * vec3(vUV, 1.0);
	vec2 t = p.xy / p.z;
	if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) {
		gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
		return;
	}
	gl_FragColor = vec4(texture2D(uTex, t).rgb, 1.0);
}`;

function compile(gl, type, source) {
	const shader = gl.createShader(type);
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
	}
	return shader;
}

export class WarpRenderer {
	constructor(canvas) {
		const gl = canvas.getContext('webgl', { alpha: false, antialias: false, desynchronized: true })
			|| canvas.getContext('experimental-webgl', { alpha: false });
		if (!gl) throw new Error('WebGL is not available');
		this.canvas = canvas;
		this.gl = gl;

		const program = gl.createProgram();
		gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
		const highp = gl.getShaderPrecisionFormat?.(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
		this.precision = highp && highp.precision > 0 ? 'highp' : 'mediump';
		gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER(this.precision)));
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			throw new Error(`link: ${gl.getProgramInfoLog(program)}`);
		}
		gl.useProgram(program);
		this.program = program;
		this.uH = gl.getUniformLocation(program, 'uH');

		const buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
		const aPos = gl.getAttribLocation(program, 'aPos');
		gl.enableVertexAttribArray(aPos);
		gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

		this.texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		// Video frames are not powers of two, so clamp and stay off mipmaps.
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.uniform1i(gl.getUniformLocation(program, 'uTex'), 0);
		gl.clearColor(0, 0, 0, 1);
	}

	// Match the drawing buffer to the element's size in device pixels.
	resize(cssWidth, cssHeight, dpr = 1) {
		const w = Math.max(1, Math.round(cssWidth * dpr));
		const h = Math.max(1, Math.round(cssHeight * dpr));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}
	}

	/**
	 * @param {TexImageSource} source current camera frame
	 * @param {number[][]} quad screen corners in texture coordinates (0..1)
	 * @param {number} aspect width / height of the output rectangle
	 */
	draw(source, quad, aspect) {
		const { gl, canvas } = this;
		const H = solveHomography(UNIT_SQUARE, quad);
		if (!H) return false;

		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

		gl.viewport(0, 0, canvas.width, canvas.height);
		gl.clear(gl.COLOR_BUFFER_BIT);

		// Largest rectangle of the requested shape that fits the canvas; the
		// rest stays black rather than stretching the picture.
		let w = canvas.width, h = Math.round(canvas.width / aspect);
		if (h > canvas.height) { h = canvas.height; w = Math.round(canvas.height * aspect); }
		gl.viewport(Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);

		// GLSL matrices are column-major; ours are row-major.
		gl.uniformMatrix3fv(this.uH, false, new Float32Array([
			H[0], H[3], H[6],
			H[1], H[4], H[7],
			H[2], H[5], H[8],
		]));
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		return true;
	}
}
