/**
 * `image-analysis` on the WebGPU lane: the 256-bin BT.709 histogram, its one
 * 1 KiB readback, and the `r8uint` classification mask. Part of
 * `WebGpuChoreBackend` (`webgpuBackend.ts`), which decides whether a job may
 * run here at all (`texture-formats-tier1`, the texture size).
 */
import { CLASSIFICATION_COMPUTE_SHADER, HISTOGRAM_COMPUTE_SHADER } from './kernels';
import { isSrgbTextureFormat } from './support';
import type { GpuImageAnalysisOutput } from './types';
import { workgroupsFor } from './webgpuShared';

const HISTOGRAM_BINS = 256;
const HISTOGRAM_BYTES = HISTOGRAM_BINS * 4;

export function averageFromHistogram(histogram: Uint32Array): number {
  let sum = 0;
  let count = 0;
  for (let bucket = 0; bucket < HISTOGRAM_BINS; bucket += 1) {
    const n = histogram[bucket]!;
    sum += bucket * n;
    count += n;
  }
  return count === 0 ? 128 : sum / count;
}

/** Everything the two passes need, built together on first use. */
interface AnalysisResources {
  histogramPipeline: GPUComputePipeline;
  classificationPipeline: GPUComputePipeline;
  histogramLayout: GPUBindGroupLayout;
  classificationLayout: GPUBindGroupLayout;
  histogramBuffer: GPUBuffer;
  histogramUniformBuffer: GPUBuffer;
  maskUniformBuffer: GPUBuffer;
  histogramStagingBuffer: GPUBuffer;
}

export class GpuImageAnalysisPass {
  private readonly device: GPUDevice;
  private resources: AnalysisResources | null = null;
  /**
   * The mask the last analysis returned, for `readMaskPixels` only. The
   * caller owns it — this pass never destroys it.
   */
  private lastMaskTexture: GPUTexture | null = null;
  /** Serializes overlapping analyses, which share the staging buffer. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Build the histogram, derive average luminance, and write an r8uint mask.
   * The returned mask texture is a new one, and the caller's: it destroys it
   * once nothing binds it any more. The pass keeps no mask of its own, so it
   * never destroys one a renderer is still drawing with (the old cached mask
   * was destroyed on a size change while the frames in flight bound it).
   */
  async analyze(
    source: GPUTexture,
    width: number,
    height: number,
    avgLumHint?: number,
  ): Promise<GpuImageAnalysisOutput | null> {
    const run = this.chain.then(() => this.analyzeOnce(source, width, height, avgLumHint));
    this.chain = run.then(() => undefined, () => undefined);
    try {
      return await run;
    } catch (error) {
      console.warn('GPU image analysis failed:', error);
      return null;
    }
  }

  /** Read back the last mask's bytes, for golden / e2e validation. */
  async readMaskPixels(width: number, height: number): Promise<Uint8Array | null> {
    if (!this.lastMaskTexture) return null;
    const bytesPerRow = Math.ceil(width / 256) * 256;
    const staging = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.lastMaskTexture },
      { buffer: staging, bytesPerRow },
      [width, height, 1],
    );
    this.device.queue.submit([enc.finish()]);
    try {
      await staging.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(staging.getMappedRange());
      const packed = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) {
        packed.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width), y * width);
      }
      staging.unmap();
      return packed;
    } catch {
      return null;
    } finally {
      staging.destroy();
    }
  }

  destroy(): void {
    const r = this.resources;
    this.resources = null;
    r?.histogramBuffer.destroy();
    r?.histogramUniformBuffer.destroy();
    r?.maskUniformBuffer.destroy();
    r?.histogramStagingBuffer.destroy();
    // The last mask is its caller's to destroy.
    this.lastMaskTexture = null;
  }

  private async analyzeOnce(
    source: GPUTexture,
    width: number,
    height: number,
    avgLumHint?: number,
  ): Promise<GpuImageAnalysisOutput | null> {
    const r = this.ensureResources();
    const isSrgb = isSrgbTextureFormat(source.format);
    const srcView = source.createView({ baseMipLevel: 0, mipLevelCount: 1 });

    this.device.queue.writeBuffer(r.histogramBuffer, 0, new Uint32Array(HISTOGRAM_BINS));
    this.device.queue.writeBuffer(r.histogramUniformBuffer, 0, new Uint32Array([width, height, isSrgb ? 1 : 0, 0]));

    const histBindGroup = this.device.createBindGroup({
      layout: r.histogramLayout,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: { buffer: r.histogramBuffer } },
        { binding: 2, resource: { buffer: r.histogramUniformBuffer } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const histPass = enc.beginComputePass();
    histPass.setPipeline(r.histogramPipeline);
    histPass.setBindGroup(0, histBindGroup);
    histPass.dispatchWorkgroups(workgroupsFor(width), workgroupsFor(height));
    histPass.end();
    enc.copyBufferToBuffer(r.histogramBuffer, 0, r.histogramStagingBuffer, 0, HISTOGRAM_BYTES);
    this.device.queue.submit([enc.finish()]);

    await r.histogramStagingBuffer.mapAsync(GPUMapMode.READ);
    const histogram = new Uint32Array(HISTOGRAM_BINS);
    histogram.set(new Uint32Array(r.histogramStagingBuffer.getMappedRange().slice(0)));
    r.histogramStagingBuffer.unmap();
    const avgLuminance = avgLumHint ?? averageFromHistogram(histogram);

    const maskUniformData = new ArrayBuffer(32);
    const maskUniformU32 = new Uint32Array(maskUniformData);
    const maskUniformF32 = new Float32Array(maskUniformData);
    maskUniformU32[0] = width;
    maskUniformU32[1] = height;
    maskUniformU32[2] = isSrgb ? 1 : 0;
    maskUniformF32[4] = avgLuminance;
    this.device.queue.writeBuffer(r.maskUniformBuffer, 0, maskUniformData);

    // Allocated after the readback, so a failed map leaks nothing.
    const maskTexture = this.createMaskTexture(width, height);
    this.lastMaskTexture = maskTexture;
    const maskBindGroup = this.device.createBindGroup({
      layout: r.classificationLayout,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: maskTexture.createView() },
        { binding: 2, resource: { buffer: r.maskUniformBuffer } },
      ],
    });

    const enc2 = this.device.createCommandEncoder();
    const maskPass = enc2.beginComputePass();
    maskPass.setPipeline(r.classificationPipeline);
    maskPass.setBindGroup(0, maskBindGroup);
    maskPass.dispatchWorkgroups(workgroupsFor(width), workgroupsFor(height));
    maskPass.end();
    this.device.queue.submit([enc2.finish()]);

    return {
      kind: 'gpu-texture',
      avgLuminance: Math.round(avgLuminance),
      maskTexture,
      histogram,
    };
  }

  /** Pipelines, layouts, and the staging pool are built once and cached. */
  private ensureResources(): AnalysisResources {
    if (this.resources) return this.resources;
    const { device } = this;

    const histogramLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const classificationLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'r8uint', viewDimension: '2d' },
        },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });

    this.resources = {
      histogramLayout,
      classificationLayout,
      histogramPipeline: device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [histogramLayout] }),
        compute: { module: device.createShaderModule({ code: HISTOGRAM_COMPUTE_SHADER }), entryPoint: 'histogram_main' },
      }),
      classificationPipeline: device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [classificationLayout] }),
        compute: {
          module: device.createShaderModule({ code: CLASSIFICATION_COMPUTE_SHADER }),
          entryPoint: 'classification_main',
        },
      }),
      histogramBuffer: device.createBuffer({
        size: HISTOGRAM_BYTES,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }),
      histogramUniformBuffer: device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      maskUniformBuffer: device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      histogramStagingBuffer: device.createBuffer({
        size: HISTOGRAM_BYTES,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
    };
    return this.resources;
  }

  private createMaskTexture(width: number, height: number): GPUTexture {
    return this.device.createTexture({
      label: 'classification mask (gpu)',
      size: [width, height, 1],
      format: 'r8uint',
      usage:
        GPUTextureUsage.STORAGE_BINDING
        | GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.COPY_DST
        | GPUTextureUsage.COPY_SRC,
    });
  }
}
