import {
  canAnalyzeTexture,
  detectGpuComputeSupport,
  isSrgbTextureFormat,
  type GpuComputeSupport,
} from './computeSupport';
import { CLASSIFICATION_COMPUTE_SHADER, HISTOGRAM_COMPUTE_SHADER } from './wgslSnippets';

export interface GpuImageAnalysisResult {
  avgLuminance: number;
  maskTexture: GPUTexture;
  histogram: Uint32Array;
}

const WORKGROUP_SIZE = 8;

function averageFromHistogram(histogram: Uint32Array): number {
  let sum = 0;
  let count = 0;
  for (let bucket = 0; bucket < 256; bucket += 1) {
    const n = histogram[bucket];
    sum += bucket * n;
    count += n;
  }
  return count === 0 ? 128 : sum / count;
}

/**
 * WebGPU compute passes for BT.709 histogram and r8uint classification masks.
 * Falls back are handled by callers (WasmEngine / bandClassification.ts).
 */
export class GpuImageAnalysis {
  private readonly device: GPUDevice;
  readonly support: GpuComputeSupport;

  private histogramPipeline: GPUComputePipeline | null = null;
  private classificationPipeline: GPUComputePipeline | null = null;
  private histogramBGL: GPUBindGroupLayout | null = null;
  private classificationBGL: GPUBindGroupLayout | null = null;
  private histogramBuffer: GPUBuffer | null = null;
  private histogramUniformBuffer: GPUBuffer | null = null;
  private maskUniformBuffer: GPUBuffer | null = null;
  private histogramStagingBuffer: GPUBuffer | null = null;

  private cachedMaskTexture: GPUTexture | null = null;
  private cachedMaskWidth = 0;
  private cachedMaskHeight = 0;

  /** Read back mask bytes for golden / e2e validation. */
  async readMaskPixels(width: number, height: number): Promise<Uint8Array | null> {
    if (!this.cachedMaskTexture) return null;
    const bytesPerRow = Math.ceil(width / 256) * 256;
    const staging = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.cachedMaskTexture },
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
      staging.destroy();
      return packed;
    } catch {
      staging.destroy();
      return null;
    }
  }

  constructor(device: GPUDevice) {
    this.device = device;
    this.support = detectGpuComputeSupport(device);
  }

  isSupported(): boolean {
    return this.support.available;
  }

  canAnalyze(width: number, height: number): boolean {
    return canAnalyzeTexture(this.support, width, height);
  }

  /**
   * Build histogram (256 bins), derive average luminance, and write an r8uint mask.
   * The returned mask texture is owned by this instance and reused across calls.
   */
  async analyze(
    source: GPUTexture,
    width: number,
    height: number,
    avgLumHint?: number,
  ): Promise<GpuImageAnalysisResult | null> {
    if (!this.canAnalyze(width, height)) return null;

    this.ensurePipelines();
    const isSrgb = isSrgbTextureFormat(source.format);
    const srcView = source.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    const maskTexture = this.ensureMaskTexture(width, height);

    this.clearHistogramBuffer();

    const histUniformData = new Uint32Array([width, height, isSrgb ? 1 : 0, 0]);
    this.device.queue.writeBuffer(this.histogramUniformBuffer!, 0, histUniformData);

    const histBindGroup = this.device.createBindGroup({
      layout: this.histogramBGL!,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: { buffer: this.histogramBuffer! } },
        { binding: 2, resource: { buffer: this.histogramUniformBuffer! } },
      ],
    });

    const enc = this.device.createCommandEncoder();
    const histPass = enc.beginComputePass();
    histPass.setPipeline(this.histogramPipeline!);
    histPass.setBindGroup(0, histBindGroup);
    histPass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP_SIZE),
      Math.ceil(height / WORKGROUP_SIZE),
    );
    histPass.end();

    enc.copyBufferToBuffer(
      this.histogramBuffer!,
      0,
      this.histogramStagingBuffer!,
      0,
      256 * 4,
    );
    this.device.queue.submit([enc.finish()]);

    await this.histogramStagingBuffer!.mapAsync(GPUMapMode.READ);
    const mapped = new Uint32Array(this.histogramStagingBuffer!.getMappedRange().slice(0));
    this.histogramStagingBuffer!.unmap();

    const histogram = new Uint32Array(256);
    histogram.set(mapped);
    const avgLuminance = avgLumHint ?? averageFromHistogram(histogram);

    const maskUniformData = new ArrayBuffer(32);
    const maskUniformU32 = new Uint32Array(maskUniformData);
    const maskUniformF32 = new Float32Array(maskUniformData);
    maskUniformU32[0] = width;
    maskUniformU32[1] = height;
    maskUniformU32[2] = isSrgb ? 1 : 0;
    maskUniformF32[4] = avgLuminance;
    this.device.queue.writeBuffer(this.maskUniformBuffer!, 0, maskUniformData);

    const maskBindGroup = this.device.createBindGroup({
      layout: this.classificationBGL!,
      entries: [
        { binding: 0, resource: srcView },
        { binding: 1, resource: maskTexture.createView() },
        { binding: 2, resource: { buffer: this.maskUniformBuffer! } },
      ],
    });

    const enc2 = this.device.createCommandEncoder();
    const maskPass = enc2.beginComputePass();
    maskPass.setPipeline(this.classificationPipeline!);
    maskPass.setBindGroup(0, maskBindGroup);
    maskPass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP_SIZE),
      Math.ceil(height / WORKGROUP_SIZE),
    );
    maskPass.end();
    this.device.queue.submit([enc2.finish()]);

    return {
      avgLuminance: Math.round(avgLuminance),
      maskTexture,
      histogram,
    };
  }

  destroy(): void {
    this.cachedMaskTexture?.destroy();
    this.cachedMaskTexture = null;
    this.histogramBuffer?.destroy();
    this.histogramUniformBuffer?.destroy();
    this.maskUniformBuffer?.destroy();
    this.histogramStagingBuffer?.destroy();
    this.histogramBuffer = null;
    this.histogramUniformBuffer = null;
    this.maskUniformBuffer = null;
    this.histogramStagingBuffer = null;
  }

  private ensurePipelines(): void {
    if (this.histogramPipeline && this.classificationPipeline) return;

    const histogramModule = this.device.createShaderModule({ code: HISTOGRAM_COMPUTE_SHADER });
    const classificationModule = this.device.createShaderModule({ code: CLASSIFICATION_COMPUTE_SHADER });

    this.histogramBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this.classificationBGL = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'r8uint', viewDimension: '2d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
      ],
    });

    this.histogramPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.histogramBGL] }),
      compute: { module: histogramModule, entryPoint: 'histogram_main' },
    });

    this.classificationPipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.classificationBGL] }),
      compute: { module: classificationModule, entryPoint: 'classification_main' },
    });

    this.histogramBuffer = this.device.createBuffer({
      size: 256 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.histogramUniformBuffer = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.maskUniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.histogramStagingBuffer = this.device.createBuffer({
      size: 256 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  private clearHistogramBuffer(): void {
    if (!this.histogramBuffer) return;
    this.device.queue.writeBuffer(this.histogramBuffer, 0, new Uint32Array(256));
  }

  private ensureMaskTexture(width: number, height: number): GPUTexture {
    if (
      this.cachedMaskTexture
      && this.cachedMaskWidth === width
      && this.cachedMaskHeight === height
    ) {
      return this.cachedMaskTexture;
    }

    this.cachedMaskTexture?.destroy();
    this.cachedMaskTexture = this.device.createTexture({
      size: [width, height, 1],
      format: 'r8uint',
      usage:
        GPUTextureUsage.STORAGE_BINDING
        | GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.COPY_DST,
    });
    this.cachedMaskWidth = width;
    this.cachedMaskHeight = height;
    return this.cachedMaskTexture;
  }
}
