import { PROFILE_LUT_HEIGHT, PROFILE_LUT_WIDTH } from '../color/colorProfile';

/**
 * WebGL2 mirror of `ProfileLutTexture` — a 256×3 RGBA8 colour-profile LUT read
 * with `texelFetch` (NEAREST, clamped, no mips). Uploaded only when the baked
 * LUT array identity changes.
 */
export class WebGLProfileLut {
  readonly texture: WebGLTexture;
  private readonly gl: WebGL2RenderingContext;
  private uploaded: Uint8Array | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create colour-profile LUT texture.');
    this.texture = texture;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, PROFILE_LUT_WIDTH, PROFILE_LUT_HEIGHT, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(PROFILE_LUT_WIDTH * PROFILE_LUT_HEIGHT * 4),
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  update(lut: Uint8Array | null | undefined): void {
    if (!lut || lut === this.uploaded) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, PROFILE_LUT_WIDTH, PROFILE_LUT_HEIGHT,
      gl.RGBA, gl.UNSIGNED_BYTE, lut,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.uploaded = lut;
  }

  destroy(): void {
    this.gl.deleteTexture(this.texture);
    this.uploaded = null;
  }
}
