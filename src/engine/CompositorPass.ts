import {
  createTexturePairCache,
  getOrCreateTexturePairBindGroup,
  invalidateTexturePairCache,
  type TexturePairBindGroupCacheEntry,
} from './BindGroupCache';
import type { WebGPUPipelines } from './WebGPUPipelines';

export interface CompositorUniformParams {
  tracerAboveOp: number;
  tracerBelowOp: number;
  layerBlendMode: number;
  tracerBlendMode: number;
  layerOpacities: [number, number, number];
  diagnosticsOpacity: number;
  stampBoost: number;
  outputMode: number;
  tracerMode: number;
  diagnosticsMode: boolean;
  viewportQuarterZoom: boolean;
  halfOverlayAlpha: number;
  viewportHalfOverlay: boolean;
}

export class CompositorPass {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly bgl: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  readonly uniformBuf: GPUBuffer;
  readonly previewUniformBuf: GPUBuffer;
  private readonly uniformData = new ArrayBuffer(64);
  private readonly uniformF32 = new Float32Array(this.uniformData);
  private readonly uniformU32 = new Uint32Array(this.uniformData);
  private readonly previewUniformData = new ArrayBuffer(64);
  private readonly previewUniformU32 = new Uint32Array(this.previewUniformData);
  private readonly bindGroupCache: TexturePairBindGroupCacheEntry[];
  private readonly previewBindGroupCache: TexturePairBindGroupCacheEntry[];

  constructor(device: GPUDevice, pipelines: WebGPUPipelines, sampler: GPUSampler) {
    this.device = device;
    this.sampler = sampler;
    this.bgl = pipelines.compositorBGL;
    this.pipeline = pipelines.createCompositorPipeline();
    this.uniformBuf = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.previewUniformBuf = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroupCache = createTexturePairCache(2);
    this.previewBindGroupCache = createTexturePairCache(2);
  }

  get pipelineHandle(): GPURenderPipeline {
    return this.pipeline;
  }

  invalidateCaches(): void {
    invalidateTexturePairCache(this.bindGroupCache);
    invalidateTexturePairCache(this.previewBindGroupCache);
  }

  writeUniforms(params: CompositorUniformParams): void {
    this.uniformF32[0] = params.tracerAboveOp;
    this.uniformF32[1] = params.tracerBelowOp;
    this.uniformU32[2] = params.layerBlendMode;
    this.uniformU32[3] = params.tracerBlendMode;
    this.uniformF32[4] = params.layerOpacities[0];
    this.uniformF32[5] = params.layerOpacities[1];
    this.uniformF32[6] = params.layerOpacities[2];
    this.uniformF32[7] = params.diagnosticsOpacity;
    this.uniformF32[8] = params.stampBoost;
    this.uniformU32[9] = params.outputMode;
    this.uniformU32[10] = params.tracerMode;
    this.uniformU32[11] = params.diagnosticsMode ? 1 : 0;
    this.uniformU32[12] = params.viewportQuarterZoom ? 1 : 0;
    this.uniformF32[13] = params.halfOverlayAlpha;
    this.uniformU32[14] = params.viewportHalfOverlay ? 1 : 0;

    this.device.queue.writeBuffer(this.uniformBuf, 0, this.uniformData);

    // Preview pass shares compositor uniforms but disables viewport effects.
    new Uint8Array(this.previewUniformData).set(new Uint8Array(this.uniformData));
    this.previewUniformU32[12] = 0;
    this.previewUniformU32[14] = 0;
    this.device.queue.writeBuffer(this.previewUniformBuf, 0, this.previewUniformData);
  }

  encode(
    enc: GPUCommandEncoder,
    targetView: GPUTextureView,
    layerTextures: [GPUTexture, GPUTexture, GPUTexture],
    persistBelow: GPUTexture,
    persistAbove: GPUTexture,
    pingPong: 0 | 1,
  ): void {
    const bg = this.getBindGroup(
      this.bindGroupCache[pingPong],
      layerTextures,
      persistBelow,
      persistAbove,
      this.uniformBuf,
    );

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  encodePreview(
    enc: GPUCommandEncoder,
    targetView: GPUTextureView,
    layerTextures: [GPUTexture, GPUTexture, GPUTexture],
    persistBelow: GPUTexture,
    persistAbove: GPUTexture,
    pingPong: 0 | 1,
  ): void {
    const bg = this.getBindGroup(
      this.previewBindGroupCache[pingPong],
      layerTextures,
      persistBelow,
      persistAbove,
      this.previewUniformBuf,
    );

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  destroy(): void {
    this.uniformBuf.destroy();
    this.previewUniformBuf.destroy();
  }

  private getBindGroup(
    entry: TexturePairBindGroupCacheEntry,
    layerTextures: [GPUTexture, GPUTexture, GPUTexture],
    persistBelow: GPUTexture,
    persistAbove: GPUTexture,
    uniformBuf: GPUBuffer,
  ): GPUBindGroup {
    return getOrCreateTexturePairBindGroup(
      this.device,
      entry,
      this.bgl,
      layerTextures,
      persistBelow,
      persistAbove,
      [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: layerTextures[0].createView() },
        { binding: 2, resource: layerTextures[1].createView() },
        { binding: 3, resource: layerTextures[2].createView() },
        { binding: 4, resource: persistBelow.createView() },
        { binding: 5, resource: persistAbove.createView() },
        { binding: 6, resource: { buffer: uniformBuf } },
      ],
    );
  }
}
