import {
  createTexturePairCache,
  getOrCreateTexturePairBindGroup,
  invalidateTexturePairCache,
  type TexturePairBindGroupCacheEntry,
} from './BindGroupCache';
import type { WebGPUPipelines } from './WebGPUPipelines';
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

  constructor(
    device: GPUDevice,
    pipelines: WebGPUPipelines,
    internalFormat: GPUTextureFormat,
    sampler: GPUSampler,
  ) {
    this.device = device;
    this.internalFormat = internalFormat;
    this.sampler = sampler;
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
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    this.aboveTextures[0] = createPersistTex();
    this.aboveTextures[1] = createPersistTex();
    this.belowTextures[0] = createPersistTex();
    this.belowTextures[1] = createPersistTex();
    this.diagnosticTextures[0] = createDiagnosticTex();
    this.diagnosticTextures[1] = createDiagnosticTex();
    this.pingPong = 0;
    this.invalidateCaches();
  }

  invalidateCaches(): void {
    invalidateTexturePairCache(this.belowBindGroupCache);
    invalidateTexturePairCache(this.aboveBindGroupCache);
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

  encode(
    enc: GPUCommandEncoder,
    layerTextures: [GPUTexture, GPUTexture, GPUTexture],
    params: PersistenceEncodeParams,
  ): void {
    if (params.paused) return;

    const readIdx: 0 | 1 = this.pingPong;
    const writeIdx: 0 | 1 = readIdx === 0 ? 1 : 0;

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
  }

  private encodeSingle(
    enc: GPUCommandEncoder,
    layerTextures: [GPUTexture, GPUTexture, GPUTexture],
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
        { binding: 1, resource: layerTextures[0].createView() },
        { binding: 2, resource: layerTextures[1].createView() },
        { binding: 3, resource: layerTextures[2].createView() },
        { binding: 4, resource: prevTexture.createView() },
        { binding: 5, resource: { buffer: uniformBuf } },
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
}
