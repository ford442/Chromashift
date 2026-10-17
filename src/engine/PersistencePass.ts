import {
  createTexturePairCache,
  createTwoTextureCache,
  getOrCreateTexturePairBindGroup,
  getOrCreateTwoTextureBindGroup,
  invalidateTexturePairCache,
  invalidateTwoTextureCache,
  layerTextureEntries,
  type LayerTextures,
  type TexturePairBindGroupCacheEntry,
  type TwoTextureBindGroupCacheEntry,
} from './BindGroupCache';
import type { WebGPUPipelines } from './WebGPUPipelines';
import type { WebGpuChoreBackend } from './compute/chores/webgpuBackend';
import { acquireGpuChoreSession, type GpuChoreLease } from './compute/GpuChoreSession';
import { persistUniforms, rendererStateValue } from './graph/exec/uniforms';
import { createUniformData, packUniforms, type UniformValues } from './graph/templates/uniformLayout';
import { PERSIST_MOTION_UNIFORMS, PERSIST_UNIFORMS, type PersistUniformName } from './graph/templates/wgsl';
import { PERSIST_COMPOSITE_MOTION_UNIFORMS, PERSIST_COMPOSITE_UNIFORMS } from './shaders/persistence';
import type { RendererState } from './types/RendererState';

export interface PersistenceEncodeParams {
  /**
   * Read through `persistUniforms()` — the same tracer, stamp and motion values
   * every other encode path writes. A paused state encodes nothing.
   */
  state: RendererState;
  fps: number;
  /**
   * Quarter-resolution motion field from the `motion-field` chore. The temporal
   * term engages only when the state selects a motion mode *and* this exists;
   * otherwise the frame takes the original code path — the original
   * pipelines, the original bind group layouts, no motion texture bound
   * anywhere — so a device that could not produce a field degrades to today's
   * behaviour rather than to a blank tracer.
   */
  motionTexture?: GPUTexture | null;
}

type PersistValues = UniformValues<PersistUniformName>;

/** The three values the coincidence compute kernel stamps with. */
export type CoincidenceStampValues = Pick<PersistValues, 'colorThresh' | 'stampBoost' | 'tracerMode'>;

/** One cached motion bind group plus the inputs it was built from. */
interface MotionBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  prevTexture: GPUTexture | null;
  motionTexture: GPUTexture | null;
  extraTexture: GPUTexture | null;
}

function createMotionCache(size: number): MotionBindGroupCacheEntry[] {
  return Array.from({ length: size }, () => ({
    bindGroup: null,
    prevTexture: null,
    motionTexture: null,
    extraTexture: null,
  }));
}

export class PersistencePass {
  readonly aboveTextures: [GPUTexture | null, GPUTexture | null] = [null, null];
  readonly belowTextures: [GPUTexture | null, GPUTexture | null] = [null, null];
  readonly diagnosticTextures: [GPUTexture | null, GPUTexture | null] = [null, null];

  pingPong: 0 | 1 = 0;

  private readonly device: GPUDevice;
  private readonly internalFormat: GPUTextureFormat;
  private readonly pipeline: GPURenderPipeline;
  private readonly bgl: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  private readonly aboveUniformBuf: GPUBuffer;
  private readonly belowUniformBuf: GPUBuffer;
  /** CPU scratch, one per layout; `writeBuffer` copies it out at once. */
  private readonly uniformData = createUniformData(PERSIST_UNIFORMS);
  private readonly motionUniformData = createUniformData(PERSIST_MOTION_UNIFORMS);
  private readonly compositeUniformData = createUniformData(PERSIST_COMPOSITE_UNIFORMS);
  private readonly compositeMotionUniformData = createUniformData(PERSIST_COMPOSITE_MOTION_UNIFORMS);
  private readonly belowBindGroupCache: TexturePairBindGroupCacheEntry[];
  private readonly aboveBindGroupCache: TexturePairBindGroupCacheEntry[];

  /**
   * Compute-fed persistence path: a `coincidence` compute pass writes the
   * overlap stamp once per frame (instead of the fragment shader recomputing
   * the same 3-layer overlap math twice, once per above/below duration), and
   * a lighter composite fragment pass just decays/selects against it.
   * Feature-detected per frame; falls back to `encodeSingle()` below when the
   * device lacks compute storage-texture support (see `docs/wasm-engine.md`).
   */
  private readonly coincidenceLease: GpuChoreLease;
  private readonly coincidenceBackend: WebGpuChoreBackend;
  private readonly compositePipeline: GPURenderPipeline;
  private readonly compositeBGL: GPUBindGroupLayout;
  private readonly belowCompositeUniformBuf: GPUBuffer;
  private readonly aboveCompositeUniformBuf: GPUBuffer;
  private readonly belowCompositeCache: TwoTextureBindGroupCacheEntry[];
  private readonly aboveCompositeCache: TwoTextureBindGroupCacheEntry[];
  private stampTexture: GPUTexture | null = null;
  private tracerWidth = 0;
  private tracerHeight = 0;

  /**
   * Motion-aware twins of the two pipelines above, compiled on first use.
   * A session that never leaves `motionMode: 'off'` never pays for the extra
   * shader modules.
   */
  private readonly pipelines: WebGPUPipelines;
  private motionPipeline: GPURenderPipeline | null = null;
  private motionCompositePipeline: GPURenderPipeline | null = null;
  private readonly belowMotionUniformBuf: GPUBuffer;
  private readonly aboveMotionUniformBuf: GPUBuffer;
  private readonly belowMotionCache = createMotionCache(2);
  private readonly aboveMotionCache = createMotionCache(2);
  private readonly belowMotionCompositeCache = createMotionCache(2);
  private readonly aboveMotionCompositeCache = createMotionCache(2);

  constructor(
    device: GPUDevice,
    pipelines: WebGPUPipelines,
    internalFormat: GPUTextureFormat,
    sampler: GPUSampler,
  ) {
    this.device = device;
    this.internalFormat = internalFormat;
    this.sampler = sampler;
    this.pipelines = pipelines;
    this.bgl = pipelines.persistBGL;
    this.pipeline = pipelines.createPersistPipeline();
    this.aboveUniformBuf = device.createBuffer({
      size: PERSIST_UNIFORMS.bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.belowUniformBuf = device.createBuffer({
      size: PERSIST_UNIFORMS.bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.belowBindGroupCache = createTexturePairCache(2);
    this.aboveBindGroupCache = createTexturePairCache(2);

    // Borrowed, not constructed: analysis and motion-field share this backend.
    this.coincidenceLease = acquireGpuChoreSession(device);
    this.coincidenceBackend = this.coincidenceLease.backend;
    this.compositeBGL = pipelines.persistCompositeBGL;
    this.compositePipeline = pipelines.createPersistCompositePipeline();
    this.belowCompositeUniformBuf = device.createBuffer({
      size: PERSIST_COMPOSITE_UNIFORMS.bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.aboveCompositeUniformBuf = device.createBuffer({
      size: PERSIST_COMPOSITE_UNIFORMS.bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.belowCompositeCache = createTwoTextureCache(2);
    this.aboveCompositeCache = createTwoTextureCache(2);
    // One buffer per timescale serves both motion variants: the fused pass
    // spends its block's three tail pads and the composite pass grows into a
    // full 32 bytes, so the two layouts are the same size.
    const motionBytes = Math.max(PERSIST_MOTION_UNIFORMS.bytes, PERSIST_COMPOSITE_MOTION_UNIFORMS.bytes);
    this.belowMotionUniformBuf = device.createBuffer({
      size: motionBytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.aboveMotionUniformBuf = device.createBuffer({
      size: motionBytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  ensureTextures(tracerW: number, tracerH: number): void {
    const above = this.aboveTextures[0];
    if (above && above.width === tracerW && above.height === tracerH) return;

    this.destroyTextures();
    const createPersistTex = () => this.device.createTexture({
      size: [tracerW, tracerH, 1],
      format: this.internalFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const createDiagnosticTex = () => this.device.createTexture({
      size: [tracerW, tracerH, 1],
      format: 'rgba8unorm',
      // STORAGE_BINDING is only exercised by the compute path (below); the
      // texture is otherwise identical to the fragment-fallback's diagnostic
      // render target, so one pool of textures serves both paths.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING
        | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    this.aboveTextures[0] = createPersistTex();
    this.aboveTextures[1] = createPersistTex();
    this.belowTextures[0] = createPersistTex();
    this.belowTextures[1] = createPersistTex();
    this.diagnosticTextures[0] = createDiagnosticTex();
    this.diagnosticTextures[1] = createDiagnosticTex();
    this.stampTexture = this.device.createTexture({
      size: [tracerW, tracerH, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.tracerWidth = tracerW;
    this.tracerHeight = tracerH;
    this.pingPong = 0;
    this.invalidateCaches();
  }

  invalidateCaches(): void {
    invalidateTexturePairCache(this.belowBindGroupCache);
    invalidateTexturePairCache(this.aboveBindGroupCache);
    invalidateTwoTextureCache(this.belowCompositeCache);
    invalidateTwoTextureCache(this.aboveCompositeCache);
    for (const cache of [
      this.belowMotionCache, this.aboveMotionCache,
      this.belowMotionCompositeCache, this.aboveMotionCompositeCache,
    ]) {
      for (const entry of cache) {
        entry.bindGroup = null;
        entry.prevTexture = null;
        entry.motionTexture = null;
        entry.extraTexture = null;
      }
    }
  }

  clear(): void {
    const enc = this.device.createCommandEncoder();
    const allTextures = [
      this.aboveTextures[0], this.aboveTextures[1],
      this.belowTextures[0], this.belowTextures[1],
      this.diagnosticTextures[0], this.diagnosticTextures[1],
    ];

    for (const tex of allTextures) {
      if (!tex) continue;
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: tex.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.end();
    }

    this.device.queue.submit([enc.finish()]);
    this.pingPong = 0;
  }

  /** Compute storage-texture support, feature-detected once the device is known. */
  private useComputePersistence(): boolean {
    return this.coincidenceBackend.isSupported()
      && this.coincidenceBackend.canAnalyze(this.tracerWidth, this.tracerHeight);
  }

  /**
   * Encode the coincidence compute dispatch into its own command buffer and
   * submit it immediately, rather than into the caller's frame `enc`.
   *
   * A `GPUValidationError` here doesn't throw in JS — it silently poisons the
   * *whole command buffer* it was recorded into at `submit()`. `enc` also
   * carries the layer, compositor, and (when compute persistence is active)
   * the composite render passes below, so a broken coincidence dispatch would
   * otherwise take the entire visible frame down with it, not just the
   * tracer. Isolating it here means a failure costs only this frame's stamp:
   * `stampTexture`/`diagnosticTextures[writeIdx]` simply keep whatever
   * content they already had (last frame's stamp, or a zero-initialized
   * texture on the very first one) rather than being left in a state that
   * makes the render passes reading them invalid — reading stale-but-valid
   * data is not a validation error. The `try`/`catch` covers a synchronous
   * throw for the same reason.
   */
  private encodeCoincidence(
    layerTextures: LayerTextures,
    writeIdx: 0 | 1,
    stamp: CoincidenceStampValues,
  ): void {
    try {
      const enc = this.device.createCommandEncoder();
      this.coincidenceBackend.encodeCoincidenceInto(
        enc, layerTextures, this.stampTexture!, this.diagnosticTextures[writeIdx]!,
        this.tracerWidth, this.tracerHeight,
        { colorThresh: stamp.colorThresh, stampBoost: stamp.stampBoost, tracerMode: stamp.tracerMode },
        writeIdx,
      );
      this.device.queue.submit([enc.finish()]);
    } catch (error) {
      console.warn(
        '[PersistencePass] coincidence compute failed; tracer holds the last frame’s stamp:',
        error,
      );
    }
  }

  encode(
    enc: GPUCommandEncoder,
    layerTextures: LayerTextures,
    params: PersistenceEncodeParams,
  ): void {
    const { state, fps } = params;
    if (rendererStateValue(state, 'paused')) return;

    const readIdx: 0 | 1 = this.pingPong;
    const writeIdx: 0 | 1 = readIdx === 0 ? 1 : 0;
    const below = persistUniforms(state, { role: 'below', fps });
    const above = persistUniforms(state, { role: 'above', fps });

    // A motion term only engages when a mode is selected *and* a field
    // actually exists; otherwise every pipeline, layout and uniform in this
    // frame is the one that shipped before the temporal term did.
    const motionTexture = below.motionMode !== 0 ? params.motionTexture ?? null : null;

    if (this.useComputePersistence()) {
      // The stamp does not depend on the timescale, so either one's values do.
      this.encodeCoincidence(layerTextures, writeIdx, below);
      if (motionTexture) {
        this.encodeMotionCompositeSingle(
          enc, readIdx, writeIdx,
          below, this.belowMotionUniformBuf, this.belowTextures,
          this.belowMotionCompositeCache, motionTexture,
        );
        this.encodeMotionCompositeSingle(
          enc, readIdx, writeIdx,
          above, this.aboveMotionUniformBuf, this.aboveTextures,
          this.aboveMotionCompositeCache, motionTexture,
        );
      } else {
        this.encodeCompositeSingle(
          enc, readIdx, writeIdx,
          below, this.belowCompositeUniformBuf, this.belowTextures, this.belowCompositeCache,
        );
        this.encodeCompositeSingle(
          enc, readIdx, writeIdx,
          above, this.aboveCompositeUniformBuf, this.aboveTextures, this.aboveCompositeCache,
        );
      }
    } else if (motionTexture) {
      this.encodeMotionSingle(
        enc, layerTextures, readIdx, writeIdx,
        below, this.belowMotionUniformBuf, this.belowTextures, this.belowMotionCache, motionTexture,
      );
      this.encodeMotionSingle(
        enc, layerTextures, readIdx, writeIdx,
        above, this.aboveMotionUniformBuf, this.aboveTextures, this.aboveMotionCache, motionTexture,
      );
    } else {
      this.encodeSingle(
        enc, layerTextures, readIdx, writeIdx,
        below, this.belowUniformBuf, this.belowTextures, this.belowBindGroupCache,
      );
      this.encodeSingle(
        enc, layerTextures, readIdx, writeIdx,
        above, this.aboveUniformBuf, this.aboveTextures, this.aboveBindGroupCache,
      );
    }

    this.pingPong = writeIdx;
  }

  getLatestDiagnosticTexture(): GPUTexture | null {
    // After a live encode, pingPong points at the texture just written.
    // When paused, the last write target is the opposite index.
    const idx: 0 | 1 = this.pingPong;
    return this.diagnosticTextures[idx];
  }

  getDiagnosticTextureForReadback(paused: boolean): GPUTexture | null {
    if (paused) {
      const idx: 0 | 1 = this.pingPong === 0 ? 1 : 0;
      return this.diagnosticTextures[idx];
    }
    return this.getLatestDiagnosticTexture();
  }

  resetTextures(): void {
    this.destroyTextures();
    this.pingPong = 0;
    this.invalidateCaches();
  }

  destroy(): void {
    this.destroyTextures();
    this.aboveUniformBuf.destroy();
    this.belowUniformBuf.destroy();
    this.belowCompositeUniformBuf.destroy();
    this.aboveCompositeUniformBuf.destroy();
    this.belowMotionUniformBuf.destroy();
    this.aboveMotionUniformBuf.destroy();
    this.coincidenceLease.release();
  }

  private destroyTextures(): void {
    for (const tex of [
      ...this.aboveTextures,
      ...this.belowTextures,
      ...this.diagnosticTextures,
    ]) {
      tex?.destroy();
    }
    this.aboveTextures[0] = null;
    this.aboveTextures[1] = null;
    this.belowTextures[0] = null;
    this.belowTextures[1] = null;
    this.diagnosticTextures[0] = null;
    this.diagnosticTextures[1] = null;
    this.stampTexture?.destroy();
    this.stampTexture = null;
    this.tracerWidth = 0;
    this.tracerHeight = 0;
  }

  private encodeCompositeSingle(
    enc: GPUCommandEncoder,
    readIdx: 0 | 1,
    writeIdx: 0 | 1,
    values: PersistValues,
    uniformBuf: GPUBuffer,
    textures: [GPUTexture | null, GPUTexture | null],
    cache: TwoTextureBindGroupCacheEntry[],
  ): void {
    const prevTexture = textures[readIdx]!;
    const stampTexture = this.stampTexture!;

    packUniforms(PERSIST_COMPOSITE_UNIFORMS, values, this.compositeUniformData);
    this.device.queue.writeBuffer(uniformBuf, 0, this.compositeUniformData.buffer);

    const bg = getOrCreateTwoTextureBindGroup(
      this.device,
      cache[readIdx],
      this.compositeBGL,
      stampTexture,
      prevTexture,
      [
        { binding: 0, resource: stampTexture.createView() },
        { binding: 1, resource: prevTexture.createView() },
        { binding: 2, resource: { buffer: uniformBuf } },
      ],
    );

    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: textures[writeIdx]!.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.compositePipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  private encodeSingle(
    enc: GPUCommandEncoder,
    layerTextures: LayerTextures,
    readIdx: 0 | 1,
    writeIdx: 0 | 1,
    values: PersistValues,
    uniformBuf: GPUBuffer,
    textures: [GPUTexture | null, GPUTexture | null],
    cache: TexturePairBindGroupCacheEntry[],
  ): void {
    const prevTexture = textures[readIdx]!;

    packUniforms(PERSIST_UNIFORMS, values, this.uniformData);
    this.device.queue.writeBuffer(uniformBuf, 0, this.uniformData.buffer);

    const bg = getOrCreateTexturePairBindGroup(
      this.device,
      cache[readIdx],
      this.bgl,
      layerTextures,
      prevTexture,
      uniformBuf,
      [
        { binding: 0, resource: this.sampler },
        ...layerTextureEntries(1, layerTextures),
        { binding: layerTextures.length + 1, resource: prevTexture.createView() },
        { binding: layerTextures.length + 2, resource: { buffer: uniformBuf } },
      ],
    );

    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: textures[writeIdx]!.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
        {
          view: this.diagnosticTextures[writeIdx]!.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  /** Fused coincidence + decay with the temporal term (no compute lane). */
  private encodeMotionSingle(
    enc: GPUCommandEncoder,
    layerTextures: LayerTextures,
    readIdx: 0 | 1,
    writeIdx: 0 | 1,
    values: PersistValues,
    uniformBuf: GPUBuffer,
    textures: [GPUTexture | null, GPUTexture | null],
    cache: MotionBindGroupCacheEntry[],
    motionTexture: GPUTexture,
  ): void {
    this.motionPipeline ??= this.pipelines.createPersistMotionPipeline();
    const prevTexture = textures[readIdx]!;

    packUniforms(PERSIST_MOTION_UNIFORMS, values, this.motionUniformData);
    this.device.queue.writeBuffer(uniformBuf, 0, this.motionUniformData.buffer);

    const entry = cache[readIdx];
    if (
      !entry.bindGroup
      || entry.prevTexture !== prevTexture
      || entry.motionTexture !== motionTexture
      || entry.extraTexture !== layerTextures[0]
    ) {
      entry.bindGroup = this.device.createBindGroup({
        layout: this.pipelines.persistMotionBGL,
        entries: [
          { binding: 0, resource: this.sampler },
          ...layerTextureEntries(1, layerTextures),
          { binding: layerTextures.length + 1, resource: prevTexture.createView() },
          { binding: layerTextures.length + 2, resource: { buffer: uniformBuf } },
          { binding: layerTextures.length + 3, resource: motionTexture.createView() },
        ],
      });
      entry.prevTexture = prevTexture;
      entry.motionTexture = motionTexture;
      entry.extraTexture = layerTextures[0];
    }

    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: textures[writeIdx]!.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
        {
          view: this.diagnosticTextures[writeIdx]!.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.motionPipeline);
    pass.setBindGroup(0, entry.bindGroup);
    pass.draw(6);
    pass.end();
  }

  /** Compute-fed composite with the temporal term. */
  private encodeMotionCompositeSingle(
    enc: GPUCommandEncoder,
    readIdx: 0 | 1,
    writeIdx: 0 | 1,
    values: PersistValues,
    uniformBuf: GPUBuffer,
    textures: [GPUTexture | null, GPUTexture | null],
    cache: MotionBindGroupCacheEntry[],
    motionTexture: GPUTexture,
  ): void {
    this.motionCompositePipeline ??= this.pipelines.createPersistCompositeMotionPipeline();
    const prevTexture = textures[readIdx]!;
    const stampTexture = this.stampTexture!;

    packUniforms(PERSIST_COMPOSITE_MOTION_UNIFORMS, values, this.compositeMotionUniformData);
    this.device.queue.writeBuffer(uniformBuf, 0, this.compositeMotionUniformData.buffer);

    const entry = cache[readIdx];
    if (
      !entry.bindGroup
      || entry.prevTexture !== prevTexture
      || entry.motionTexture !== motionTexture
      || entry.extraTexture !== stampTexture
    ) {
      entry.bindGroup = this.device.createBindGroup({
        layout: this.pipelines.persistCompositeMotionBGL,
        entries: [
          { binding: 0, resource: stampTexture.createView() },
          { binding: 1, resource: prevTexture.createView() },
          { binding: 2, resource: { buffer: uniformBuf } },
          { binding: 3, resource: this.sampler },
          { binding: 4, resource: motionTexture.createView() },
        ],
      });
      entry.prevTexture = prevTexture;
      entry.motionTexture = motionTexture;
      entry.extraTexture = stampTexture;
    }

    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: textures[writeIdx]!.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.motionCompositePipeline);
    pass.setBindGroup(0, entry.bindGroup);
    pass.draw(6);
    pass.end();
  }
}
