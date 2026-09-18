import {
  PASSTHROUGH_VERTEX_SOURCE,
  PERSISTENCE_FRAGMENT_SOURCE,
  PERSISTENCE_MOTION_FRAGMENT_SOURCE,
} from './shaders';
import {
  bindTexture,
  createProgram,
  destroyProgram,
  type ProgramInfo,
  uniform1f,
  uniform1i,
  activateProgram,
} from './programUtils';
import { createTarget, destroyTarget, type RenderTarget } from './resources';
import type { RendererState } from '../types/RendererState';
import type { CpuMotionField } from '../types/RendererContracts';

/**
 * Texture unit the motion field is bound to, both when uploading and at draw
 * time. Uploading on the same unit it is sampled from means this never leaves
 * a stray binding on a unit another pass is about to use.
 */
const MOTION_TEXTURE_UNIT = 4;

export class WebGLPersistencePass {
  readonly tracerAbove: [RenderTarget | null, RenderTarget | null] = [null, null];
  readonly tracerBelow: [RenderTarget | null, RenderTarget | null] = [null, null];
  pingPong: 0 | 1 = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly program: ProgramInfo;
  private width = 0;
  private height = 0;

  /**
   * Motion-aware program, linked on first use. With `motionMode: 'off'` the
   * backend keeps running the program above, unchanged — which is what makes
   * "off is pixel identical" true on this backend too.
   */
  private motionProgram: ProgramInfo | null = null;
  private motionTexture: WebGLTexture | null = null;
  private motionWidth = 0;
  private motionHeight = 0;
  /**
   * Whether `motionTexture` is the three-channel `RGB16F` flow field or the
   * single-channel `R16F` magnitude one. A mode switch changes the format, so
   * it is part of the "does this texture still fit?" test alongside the size.
   */
  private motionHasFlow = false;
  /**
   * Interleaving scratch for the `RGB16F` upload, reused across frames. The
   * chore hands back a magnitude array and a flow array; GL wants one buffer.
   */
  private motionPacked: Float32Array | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, PASSTHROUGH_VERTEX_SOURCE, PERSISTENCE_FRAGMENT_SOURCE);
  }

  /**
   * Upload the latest motion field. Pass `null` to drop it — the next frame
   * falls back to the non-motion program rather than differencing against a
   * stale field.
   */
  setMotionField(motion: CpuMotionField | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + MOTION_TEXTURE_UNIT);
    if (!motion || motion.width <= 0 || motion.height <= 0) {
      if (this.motionTexture) {
        gl.deleteTexture(this.motionTexture);
        this.motionTexture = null;
        this.motionWidth = 0;
        this.motionHeight = 0;
        this.motionHasFlow = false;
      }
      return;
    }

    // `direction` needs three channels (magnitude + velocity); every other mode
    // samples `.r` alone and keeps paying for exactly one.
    const cells = motion.width * motion.height;
    const hasFlow = Boolean(motion.flow) && motion.flow!.length >= cells * 2;
    const internalFormat = hasFlow ? gl.RGB16F : gl.R16F;
    const format = hasFlow ? gl.RGB : gl.RED;
    const data = hasFlow ? this.packMotionField(motion, cells) : motion.field;

    const recreate = !this.motionTexture
      || this.motionWidth !== motion.width
      || this.motionHeight !== motion.height
      || this.motionHasFlow !== hasFlow;

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
      this.motionWidth = motion.width;
      this.motionHeight = motion.height;
      this.motionHasFlow = hasFlow;
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.motionTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, motion.width, motion.height,
      format, gl.FLOAT, data,
    );
  }

  /**
   * Interleave the chore's two arrays into one `(magnitude, vx, vy)` buffer,
   * matching the WebGPU lane's `rgba16float` channel order so both backends'
   * `direction` shader reads the same thing out of the same swizzle.
   */
  private packMotionField(motion: CpuMotionField, cells: number): Float32Array {
    if (!this.motionPacked || this.motionPacked.length !== cells * 3) {
      this.motionPacked = new Float32Array(cells * 3);
    }
    const packed = this.motionPacked;
    const flow = motion.flow!;
    for (let i = 0; i < cells; i += 1) {
      packed[i * 3] = motion.field[i];
      packed[i * 3 + 1] = flow[i * 2];
      packed[i * 3 + 2] = flow[i * 2 + 1];
    }
    return packed;
  }

  hasMotionField(): boolean {
    return this.motionTexture !== null;
  }

  ensureTextures(width: number, height: number): void {
    if (this.width === width && this.height === height && this.tracerAbove[0] !== null) return;
    this.destroyTextures();
    this.tracerAbove[0] = createTarget(this.gl, width, height);
    this.tracerAbove[1] = createTarget(this.gl, width, height);
    this.tracerBelow[0] = createTarget(this.gl, width, height);
    this.tracerBelow[1] = createTarget(this.gl, width, height);
    this.width = width;
    this.height = height;
    this.clear();
  }

  clear(): void {
    const gl = this.gl;
    for (const target of [...this.tracerAbove, ...this.tracerBelow]) {
      if (!target) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pingPong = 0;
  }

  render(
    write: RenderTarget,
    read: RenderTarget,
    layerTextures: readonly RenderTarget[],
    decay: number,
    state: RendererState,
  ): void {
    const gl = this.gl;
    // The temporal term engages only when a mode is selected *and* a field
    // exists; otherwise this is byte for byte the pass that shipped before.
    const motionMode = state.motionMode ?? 0;
    const useMotion = motionMode !== 0 && this.motionTexture !== null;
    if (useMotion) {
      this.motionProgram ??= createProgram(
        gl,
        PASSTHROUGH_VERTEX_SOURCE,
        PERSISTENCE_MOTION_FRAGMENT_SOURCE,
      );
    }
    const program = useMotion ? this.motionProgram! : this.program;

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.framebuffer);
    gl.viewport(0, 0, write.width, write.height);
    activateProgram(gl, program);
    bindTexture(gl, program, 'u_layer0', 0, layerTextures[0].texture);
    bindTexture(gl, program, 'u_layer1', 1, layerTextures[1].texture);
    bindTexture(gl, program, 'u_layer2', 2, layerTextures[2].texture);
    bindTexture(gl, program, 'u_previous', 3, read.texture);
    uniform1f(gl, program, 'u_decay', state.paused ? 1 : decay);
    uniform1f(gl, program, 'u_stampBoost', state.stampBoost ?? 1.8);
    uniform1i(gl, program, 'u_tracerMode', state.tracerMode ?? 0);
    uniform1i(gl, program, 'u_peakMode', state.peakCollisionsOnly ? 1 : 0);
    if (useMotion) {
      bindTexture(gl, program, 'u_motion', MOTION_TEXTURE_UNIT, this.motionTexture!);
      uniform1i(gl, program, 'u_motionMode', motionMode);
      uniform1f(gl, program, 'u_motionGain', state.motionGain ?? 1);
      uniform1f(gl, program, 'u_motionDecayBias', state.motionDecayBias ?? 0.5);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  advancePingPong(paused: boolean | undefined): void {
    if (!paused) this.pingPong = (1 - this.pingPong) as 0 | 1;
  }

  destroy(): void {
    this.destroyTextures();
    this.setMotionField(null);
    this.motionPacked = null;
    destroyProgram(this.gl, this.program);
    if (this.motionProgram) {
      destroyProgram(this.gl, this.motionProgram);
      this.motionProgram = null;
    }
  }

  private destroyTextures(): void {
    for (const slot of [0, 1] as const) {
      if (this.tracerAbove[slot]) {
        destroyTarget(this.gl, this.tracerAbove[slot]!);
        this.tracerAbove[slot] = null;
      }
      if (this.tracerBelow[slot]) {
        destroyTarget(this.gl, this.tracerBelow[slot]!);
        this.tracerBelow[slot] = null;
      }
    }
    this.width = 0;
    this.height = 0;
  }
}
