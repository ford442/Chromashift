/**
 * `coincidence` on the WebGPU lane: the stamp / diagnostic compute pass over
 * N layer textures. Part of `WebGpuChoreBackend` (`webgpuBackend.ts`).
 *
 * Chromashift itself no longer runs this kernel: the pass graph's
 * accumulators run the fused fragment stamp (docs/PASS_GRAPH.md § *The
 * compute-fed stamp*). It stays because the facade is the sibling apps'
 * module boundary, and removing an op is a breaking change to it.
 */
import { emitCoincidenceComputeWgsl } from '../../graph/templates/wgsl';
import { CANONICAL_LAYER_COUNT } from '../../graph/layerSpecs';
import { layerTextureEntries, sameLayerTextures, type LayerTextures } from '../../webgpu/bindGroups';
import { COINCIDENCE_COMPUTE_SHADER } from './kernels';
import type { CoincidenceJob, GpuCoincidenceOutput } from './types';
import { workgroupsFor } from './webgpuShared';

/** Per-pixel parameters the coincidence compute pass needs, minus geometry. */
export interface CoincidenceEncodeParams {
  colorThresh: number;
  stampBoost: number;
  tracerMode: number;
}

/** The pipeline for one layer count, and what it binds. */
interface CoincidencePipeline {
  layerCount: number;
  pipeline: GPUComputePipeline;
  layout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer;
}

/** The one-shot job's outputs, reused whenever the size matches. */
interface CoincidenceTargets {
  stamp: GPUTexture;
  diag: GPUTexture;
  width: number;
  height: number;
}

interface BindGroupCacheEntry {
  bindGroup: GPUBindGroup;
  layers: LayerTextures;
  stampTexture: GPUTexture;
  diagTexture: GPUTexture;
}

export class GpuCoincidencePass {
  private readonly device: GPUDevice;
  private pipeline: CoincidencePipeline | null = null;
  private targets: CoincidenceTargets | null = null;
  /**
   * Two slots so a caller ping-ponging its output texture (as the hand
   * encoder's persistence pass did for its diagnostic texture) still gets a
   * cache hit every frame instead of a fresh bind group — and the 5 texture
   * views inside it — every single call. `cacheSlot` selects which.
   */
  private readonly bindGroups: [BindGroupCacheEntry | null, BindGroupCacheEntry | null] = [null, null];

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /** One-shot job for the async kit facade (sibling apps, tests). */
  run(job: CoincidenceJob): GpuCoincidenceOutput | null {
    const layers = job.layers;
    if (!layers) return null;
    const { stamp, diag } = this.ensureTargets(job.width, job.height);
    const enc = this.device.createCommandEncoder();
    this.encodeInto(enc, layers, stamp, diag, job.width, job.height, {
      colorThresh: job.colorThresh,
      stampBoost: job.stampBoost,
      tracerMode: job.tracerMode,
    }, 0);
    this.device.queue.submit([enc.finish()]);
    return { kind: 'gpu-coincidence', stampTexture: stamp, diagTexture: diag };
  }

  /**
   * Encode into a caller-owned encoder and caller-owned output textures — no
   * submit, no internal texture caching. `cacheSlot` picks which of the two
   * bind-group cache entries to check: pass the same ping-pong index the
   * caller uses for its own output texture.
   */
  encodeInto(
    enc: GPUCommandEncoder,
    layers: LayerTextures,
    stampTexture: GPUTexture,
    diagTexture: GPUTexture,
    width: number,
    height: number,
    params: CoincidenceEncodeParams,
    cacheSlot: 0 | 1 = 0,
  ): void {
    const p = this.ensurePipeline(layers.length);
    const uniformData = new ArrayBuffer(32);
    const uniformU32 = new Uint32Array(uniformData);
    const uniformF32 = new Float32Array(uniformData);
    uniformU32[0] = width;
    uniformU32[1] = height;
    uniformU32[2] = params.tracerMode;
    uniformF32[4] = params.colorThresh;
    uniformF32[5] = params.stampBoost;
    this.device.queue.writeBuffer(p.uniformBuffer, 0, uniformData);

    const cached = this.bindGroups[cacheSlot];
    let bindGroup: GPUBindGroup;
    if (
      cached
      && sameLayerTextures(cached.layers, layers)
      && cached.stampTexture === stampTexture && cached.diagTexture === diagTexture
    ) {
      bindGroup = cached.bindGroup;
    } else {
      const n = layers.length;
      bindGroup = this.device.createBindGroup({
        layout: p.layout,
        entries: [
          ...layerTextureEntries(0, layers),
          { binding: n, resource: stampTexture.createView() },
          { binding: n + 1, resource: diagTexture.createView() },
          { binding: n + 2, resource: { buffer: p.uniformBuffer } },
        ],
      });
      this.bindGroups[cacheSlot] = { bindGroup, layers: [...layers], stampTexture, diagTexture };
    }

    const pass = enc.beginComputePass();
    pass.setPipeline(p.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroupsFor(width), workgroupsFor(height));
    pass.end();
  }

  destroy(): void {
    this.targets?.stamp.destroy();
    this.targets?.diag.destroy();
    this.targets = null;
    this.pipeline?.uniformBuffer.destroy();
    this.pipeline = null;
    this.bindGroups[0] = null;
    this.bindGroups[1] = null;
  }

  /**
   * The pipeline for `layerCount` inputs. The kernel is emitted per layer
   * count (the shipped three-layer text is the golden, not the
   * implementation), so a session that changes its count gets a new module
   * and layout rather than one that no longer matches its shader. This
   * happens on a user-visible layer-count change, never per frame.
   */
  private ensurePipeline(layerCount: number): CoincidencePipeline {
    if (this.pipeline?.layerCount === layerCount) return this.pipeline;
    // Bind groups built against the old layout are invalid now.
    this.bindGroups[0] = null;
    this.bindGroups[1] = null;
    this.pipeline?.uniformBuffer.destroy();

    const { device } = this;
    const layout = device.createBindGroupLayout({
      entries: [
        ...Array.from({ length: layerCount }, (_, i) => ({
          binding: i,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float' as const },
        })),
        {
          binding: layerCount,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float', viewDimension: '2d' },
        },
        {
          binding: layerCount + 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d' },
        },
        { binding: layerCount + 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const module = device.createShaderModule({
      code: layerCount === CANONICAL_LAYER_COUNT ? COINCIDENCE_COMPUTE_SHADER : emitCoincidenceComputeWgsl(layerCount),
    });
    this.pipeline = {
      layerCount,
      layout,
      pipeline: device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'coincidence_main' },
      }),
      uniformBuffer: device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    };
    return this.pipeline;
  }

  /** Stamp/diag textures are reused whenever dimensions match. */
  private ensureTargets(width: number, height: number): CoincidenceTargets {
    const current = this.targets;
    if (current && current.width === width && current.height === height) return current;
    current?.stamp.destroy();
    current?.diag.destroy();
    this.targets = {
      width,
      height,
      stamp: this.device.createTexture({
        size: [width, height, 1],
        format: 'rgba32float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      }),
      diag: this.device.createTexture({
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      }),
    };
    return this.targets;
  }
}
