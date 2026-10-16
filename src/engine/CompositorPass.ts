import {
  createTexturePairCache,
  getOrCreateTexturePairBindGroup,
  invalidateTexturePairCache,
  type TexturePairBindGroupCacheEntry,
} from './BindGroupCache';
import type { WebGPUPipelines } from './WebGPUPipelines';
import { layerTextureEntries, type LayerTextures } from './BindGroupCache';
import {
  createUniformData,
  packUniforms,
  uniformOffset,
  type UniformData,
  type UniformLayout,
  type UniformValues,
} from './graph/templates/uniformLayout';
import { compositorUniformLayout, type CompositorUniformName } from './graph/templates/wgsl';

/** One frame's compositor uniforms — `compositorUniforms()` in graph/exec/uniforms.ts. */
export type CompositorUniformValues = UniformValues<CompositorUniformName>;

export class CompositorPass {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly bgl: GPUBindGroupLayout;
  private readonly sampler: GPUSampler;
  /**
   * The struct this pass's shader was emitted with. It grows by one opacity per
   * layer, so every field after the opacities moves with `pipelines.layerCount`
   * — writing it by index is how a non-three count used to land each of them
   * in the wrong slot.
   */
  private readonly layout: UniformLayout<CompositorUniformName>;
  readonly uniformBuf: GPUBuffer;
  readonly previewUniformBuf: GPUBuffer;
  private readonly uniforms: UniformData;
  private readonly previewUniforms: UniformData;
  private readonly bindGroupCache: TexturePairBindGroupCacheEntry[];
  private readonly previewBindGroupCache: TexturePairBindGroupCacheEntry[];

  constructor(device: GPUDevice, pipelines: WebGPUPipelines, sampler: GPUSampler) {
    this.device = device;
    this.sampler = sampler;
    this.bgl = pipelines.compositorBGL;
    this.pipeline = pipelines.createCompositorPipeline();
    this.layout = compositorUniformLayout(pipelines.layerCount);
    this.uniforms = createUniformData(this.layout);
    this.previewUniforms = createUniformData(this.layout);
    this.uniformBuf = device.createBuffer({
      size: this.layout.bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.previewUniformBuf = device.createBuffer({
      size: this.layout.bytes,
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

  writeUniforms(values: CompositorUniformValues): void {
    packUniforms(this.layout, values, this.uniforms);
    this.device.queue.writeBuffer(this.uniformBuf, 0, this.uniforms.buffer);

    // Preview pass shares compositor uniforms but disables viewport effects.
    new Uint8Array(this.previewUniforms.buffer).set(new Uint8Array(this.uniforms.buffer));
    this.previewUniforms.u32[uniformOffset(this.layout, 'viewportQuarterZoom') / 4] = 0;
    this.previewUniforms.u32[uniformOffset(this.layout, 'viewportHalfOverlay') / 4] = 0;
    this.device.queue.writeBuffer(this.previewUniformBuf, 0, this.previewUniforms.buffer);
  }

  encode(
    enc: GPUCommandEncoder,
    targetView: GPUTextureView,
    layerTextures: LayerTextures,
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
    layerTextures: LayerTextures,
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
    layerTextures: LayerTextures,
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
        ...layerTextureEntries(1, layerTextures),
        { binding: layerTextures.length + 1, resource: persistBelow.createView() },
        { binding: layerTextures.length + 2, resource: persistAbove.createView() },
        { binding: layerTextures.length + 3, resource: { buffer: uniformBuf } },
      ],
    );
  }
}
