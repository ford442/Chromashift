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
import { durationToDecay } from './math/decay';

export interface PersistenceEncodeParams {
  fps: number;
  colorThresh: number;
  tracerMode: number;
  stampBoost: number;
  peakMode: number;
  belowDuration: number;
  aboveDuration: number;
  paused: boolean;
  /**
   * Temporal term (see `engine/motionModes.ts`). `0` (`off`) is the default
   * and takes the original code path: the original pipelines, the original
   * bind group layouts, no motion texture bound anywhere in the frame.
   */
  motionMode?: number;
  motionGain?: number;
  motionDecayBias?: number;
  /**
   * Quarter-resolution motion field from the `motion-field` chore. Absent (or
   * a `motionMode` of 0) falls back to the non-motion pipelines, so a device
   * that could not produce a field degrades to today's behaviour rather than
   * to a blank tracer.
   */
  motionTexture?: GPUTexture | null;
}

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
  private readonly uniformData = new ArrayBuffer(32);
  private readonly uniformF32 = new Float32Array(this.uniformData);
  private readonly uniformU32 = new Uint32Array(this.uniformData);
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
  private readonly compositeUniformData = new ArrayBuffer(16);
  private readonly compositeUniformF32 = new Float32Array(this.compositeUniformData);
  private readonly compositeUniformU32 = new Uint32Array(this.compositeUniformData);
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
  private readonly motionUniformData = new ArrayBuffer(32);
  private readonly motionUniformF32 = new Float32Array(this.motionUniformData);
  private readonly motionUniformU32 = new Uint32Array(this.motionUniformData);
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
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.belowUniformBuf = device.createBuffer({
      size: 32,
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
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.aboveCompositeUniformBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.belowCompositeCache = createTwoTextureCache(2);
    this.aboveCompositeCache = createTwoTextureCache(2);
    // The motion variants reuse the original 32-byte block; the fused pass
    // spends its three tail pads and the composite pass grows into a full one.
    this.belowMotionUniformBuf = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.aboveMotionUniformBuf = device.createBuffer({
      size: 32,
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

  encode(
    enc: GPUCommandEncoder,
    layerTextures: LayerTextures,
    params: PersistenceEncodeParams,
  ): void {
    if (params.paused) return;

    const readIdx: 0 | 1 = this.pingPong;
    const writeIdx: 0 | 1 = readIdx === 0 ? 1 : 0;

    // A motion term only engages when a mode is selected *and* a field
    // actually exists; otherwise every pipeline, layout and uniform in this
    // frame is the one that shipped before the temporal term did.
    const motion = (params.motionMode ?? 0) !== 0 && Boolean(params.motionTexture);

    if (this.useComputePersistence()) {
      this.coincidenceBackend.encodeCoincidenceInto(
        enc, layerTextures, this.stampTexture!, this.diagnosticTextures[writeIdx]!,
        this.tracerWidth, this.tracerHeight,
        { colorThresh: params.colorThresh, stampBoost: params.stampBoost, tracerMode: params.tracerMode },
        writeIdx,
      );
      if (motion) {
        this.encodeMotionCompositeSingle(
          enc, readIdx, writeIdx,
          params.belowDuration, this.belowMotionUniformBuf, this.belowTextures,
          this.belowMotionCompositeCache, params,
        );
        this.encodeMotionCompositeSingle(
          enc, readIdx, writeIdx,
          params.aboveDuration, this.aboveMotionUniformBuf, this.aboveTextures,
          this.aboveMotionCompositeCache, params,
        );
      } else {
        this.encodeCompositeSingle(
          enc, readIdx, writeIdx,
          params.belowDuration, this.belowCompositeUniformBuf, this.belowTextures, this.belowCompositeCache,
          params,
        );
        this.encodeCompositeSingle(
          enc, readIdx, writeIdx,
          params.aboveDuration, this.aboveCompositeUniformBuf, this.aboveTextures, this.aboveCompositeCache,
          params,
        );
      }
    } else if (motion) {
      this.encodeMotionSingle(
        enc, layerTextures, readIdx, writeIdx,
        params.belowDuration, this.belowMotionUniformBuf, this.belowTextures, this.belowMotionCache,
        params,
      );
      this.encodeMotionSingle(
        enc, layerTextures, readIdx, writeIdx,
        params.aboveDuration, this.aboveMotionUniformBuf, this.aboveTextures, this.aboveMotionCache,
        params,
      );
    } else {
      this.encodeSingle(
        enc, layerTextures, readIdx, writeIdx,
        params.belowDuration, this.belowUniformBuf, this.belowTextures, this.belowBindGroupCache,
        params,
      );
      this.encodeSingle(
        enc, layerTextures, readIdx, writeIdx,
        params.aboveDuration, this.aboveUniformBuf, this.aboveTextures, this.aboveBindGroupCache,
        params,
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
    duration: number,
    uniformBuf: GPUBuffer,
    textures: [GPUTexture | null, GPUTexture | null],
    cache: TwoTextureBindGroupCacheEntry[],
    params: PersistenceEncodeParams,
  ): void {
    const prevTexture = textures[readIdx]!;
    const stampTexture = this.stampTexture!;
    const decayFactor = durationToDecay(duration, params.fps);

    this.compositeUniformF32[0] = decayFactor;
    this.compositeUniformU32[1] = params.peakMode;
    this.device.queue.writeBuffer(uniformBuf, 0, this.compositeUniformData);

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
    duration: number,
    uniformBuf: GPUBuffer,
    textures: [GPUTexture | null, GPUTexture | null],
    cache: TexturePairBindGroupCacheEntry[],
    params: PersistenceEncodeParams,
  ): void {
    const prevTexture = textures[readIdx]!;
    const decayFactor = durationToDecay(duration, params.fps);

    this.uniformF32[0] = decayFactor;
    this.uniformF32[1] = params.colorThresh;
    this.uniformF32[2] = params.stampBoost;
    this.uniformU32[3] = params.tracerMode;
    this.uniformU32[4] = params.peakMode;
    this.device.queue.writeBuffer(uniformBuf, 0, this.uniformData);

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
    duration: number,
    uniformBuf: GPUBuffer,
    textures: [GPUTexture | null, GPUTexture | null],
    cache: MotionBindGroupCacheEntry[],
    params: PersistenceEncodeParams,
  ): void {
    this.motionPipeline ??= this.pipelines.createPersistMotionPipeline();
    const prevTexture = textures[readIdx]!;
    const motionTexture = params.motionTexture!;

    this.uniformF32[0] = durationToDecay(duration, params.fps);
    this.uniformF32[1] = params.colorThresh;
    this.uniformF32[2] = params.stampBoost;
    this.uniformU32[3] = params.tracerMode;
    this.uniformU32[4] = params.peakMode;
    this.uniformU32[5] = params.motionMode ?? 0;
    this.uniformF32[6] = params.motionGain ?? 0;
    this.uniformF32[7] = params.motionDecayBias ?? 0;
    this.device.queue.writeBuffer(uniformBuf, 0, this.uniformData);

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
    duration: number,
    uniformBuf: GPUBuffer,
    textures: [GPUTexture | null, GPUTexture | null],
    cache: MotionBindGroupCacheEntry[],
    params: PersistenceEncodeParams,
  ): void {
    this.motionCompositePipeline ??= this.pipelines.createPersistCompositeMotionPipeline();
    const prevTexture = textures[readIdx]!;
    const stampTexture = this.stampTexture!;
    const motionTexture = params.motionTexture!;

    this.motionUniformF32[0] = durationToDecay(duration, params.fps);
    this.motionUniformU32[1] = params.peakMode;
    this.motionUniformU32[2] = params.motionMode ?? 0;
    this.motionUniformF32[3] = params.motionGain ?? 0;
    this.motionUniformF32[4] = params.motionDecayBias ?? 0;
    this.device.queue.writeBuffer(uniformBuf, 0, this.motionUniformData);

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
