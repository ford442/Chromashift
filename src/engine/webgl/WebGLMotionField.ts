import type { CpuMotionField } from '../types/RendererContracts';

/**
 * The CPU lanes' motion field as a texture the graph's `motion-field` source
 * binds.
 *
 * There is no compute lane on WebGL, so the field arrives from the chore kit's
 * `wasm`/`ts` lanes as a small `Float32Array` (see `useLiveSource`) and is
 * uploaded at quarter resolution: `R16F` magnitude alone, or `RGB16F`
 * `(magnitude, vx, vy)` when flow was solved — the WebGPU lane's channel order,
 * so both backends' shaders read the same swizzle.
 */
export class WebGLMotionField {
  private readonly gl: WebGL2RenderingContext;
  private motionTexture: WebGLTexture | null = null;
  private width = 0;
  private height = 0;
  /**
   * Whether the texture is the three-channel flow field or the single-channel
   * magnitude one. A mode switch changes the format, so it is part of the
   * "does this texture still fit?" test alongside the size.
   */
  private hasFlow = false;
  /** Interleaving scratch for the `RGB16F` upload, reused across frames. */
  private packed: Float32Array | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** The uploaded field, or `null` when there is none. */
  get texture(): WebGLTexture | null {
    return this.motionTexture;
  }

  /**
   * Upload the latest field. `null` drops it — the next frame draws the
   * pre-motion variant rather than differencing against a stale field.
   */
  set(motion: CpuMotionField | null): void {
    const gl = this.gl;
    if (!motion || motion.width <= 0 || motion.height <= 0) {
      if (this.motionTexture) {
        gl.deleteTexture(this.motionTexture);
        this.motionTexture = null;
        this.width = 0;
        this.height = 0;
        this.hasFlow = false;
      }
      return;
    }

    // Flow needs three channels (magnitude + velocity); without it every
    // shader samples `.r` alone and the upload pays for exactly one.
    const cells = motion.width * motion.height;
    const hasFlow = Boolean(motion.flow) && motion.flow!.length >= cells * 2;
    const internalFormat = hasFlow ? gl.RGB16F : gl.R16F;
    const format = hasFlow ? gl.RGB : gl.RED;
    const data = hasFlow ? this.pack(motion, cells) : motion.field;

    const recreate = !this.motionTexture
      || this.width !== motion.width
      || this.height !== motion.height
      || this.hasFlow !== hasFlow;

    if (recreate) {
      if (this.motionTexture) gl.deleteTexture(this.motionTexture);
      this.motionTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.motionTexture);
      // Linear filtering on the quarter-scale field is what keeps a 4x4 cell
      // boundary from showing as a seam in the tracer.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // R16F/RGB16F are colour-renderable-optional but always
      // texture-filterable in WebGL2, and this texture is only ever sampled.
      gl.texImage2D(
        gl.TEXTURE_2D, 0, internalFormat, motion.width, motion.height, 0,
        format, gl.FLOAT, data,
      );
      this.width = motion.width;
      this.height = motion.height;
      this.hasFlow = hasFlow;
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.motionTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, motion.width, motion.height,
      format, gl.FLOAT, data,
    );
  }

  /** Interleave the chore's two arrays into one `(magnitude, vx, vy)` buffer. */
  private pack(motion: CpuMotionField, cells: number): Float32Array {
    if (!this.packed || this.packed.length !== cells * 3) {
      this.packed = new Float32Array(cells * 3);
    }
    const packed = this.packed;
    const flow = motion.flow!;
    for (let i = 0; i < cells; i += 1) {
      packed[i * 3] = motion.field[i];
      packed[i * 3 + 1] = flow[i * 2];
      packed[i * 3 + 2] = flow[i * 2 + 1];
    }
    return packed;
  }

  destroy(): void {
    this.set(null);
    this.packed = null;
  }
}
