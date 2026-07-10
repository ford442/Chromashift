import {
  getOrCreateSimpleTextureBindGroup,
  invalidateSimpleTextureCache,
  type SimpleTextureBindGroupCacheEntry,
} from './BindGroupCache';
import type { CollisionStats } from './types/RendererState';
import type { ExportTracerOptions, ExportTracerResult } from './types/RendererContracts';
import type { TracerInspectPass } from './TracerInspectPass';
import type { WebGPUPipelines } from './WebGPUPipelines';

export class GpuReadback {
  static readonly PREVIEW_SIZE = 128;
  static readonly DIAGNOSTIC_SIZE = 64;

  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly persistDiagnosticBlitPipeline: GPURenderPipeline;
  private readonly persistDiagnosticBlitBGL: GPUBindGroupLayout;
  private readonly persistDiagnosticSampler: GPUSampler;
  private readonly diagnosticBlitBindGroupCache: SimpleTextureBindGroupCacheEntry = {
    bindGroup: null,
    texture: null,
    sampler: null,
  };

  private previewTexture: GPUTexture | null = null;
  private previewStagingBuffer: GPUBuffer | null = null;
  private previewReadPending = false;
  private previewCaptureQueued = false;
  private previewReadCallback: ((data: Uint8ClampedArray<ArrayBuffer>) => void) | null = null;

  private diagnosticTexture: GPUTexture | null = null;
  private diagnosticStagingBuffer: GPUBuffer | null = null;
  private diagnosticReadPending = false;
  private diagnosticCaptureQueued = false;
  private diagnosticReadCallback: ((stats: CollisionStats) => void) | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat, pipelines: WebGPUPipelines) {
    this.device = device;
    this.format = format;
    this.persistDiagnosticBlitBGL = pipelines.persistDiagnosticBlitBGL;
    this.persistDiagnosticBlitPipeline = pipelines.createPersistDiagnosticBlitPipeline();
    this.persistDiagnosticSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  invalidateCaches(): void {
    invalidateSimpleTextureCache(this.diagnosticBlitBindGroupCache);
  }

  requestPreviewReadback(callback: (data: Uint8ClampedArray<ArrayBuffer>) => void): boolean {
    if (this.previewReadPending || this.previewCaptureQueued || this.previewReadCallback) return false;
    this.previewReadCallback = callback;
    this.previewCaptureQueued = true;
    return true;
  }

  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean {
    if (this.diagnosticReadPending || this.diagnosticCaptureQueued || this.diagnosticReadCallback) return false;
    this.diagnosticReadCallback = callback;
    this.diagnosticCaptureQueued = true;
    return true;
  }

  encodeQueuedReadbacks(
    enc: GPUCommandEncoder,
    onPreviewNeeded: (previewView: GPUTextureView) => void,
    persistDiagnostic: GPUTexture | null,
  ): { preview: boolean; diagnostic: boolean } {
    let preview = false;
    let diagnostic = false;

    if (this.previewCaptureQueued && !this.previewReadPending) {
      this.ensurePreviewResources();
    }
    if (this.diagnosticCaptureQueued && !this.diagnosticReadPending) {
      this.ensureDiagnosticResources();
    }

    if (this.previewCaptureQueued && this.previewTexture && this.previewStagingBuffer && this.previewReadCallback) {
      onPreviewNeeded(this.previewTexture.createView());

      const sz = GpuReadback.PREVIEW_SIZE;
      enc.copyTextureToBuffer(
        { texture: this.previewTexture },
        { buffer: this.previewStagingBuffer, bytesPerRow: sz * 4 },
        [sz, sz, 1],
      );
      this.previewCaptureQueued = false;
      preview = true;
    }

    if (this.diagnosticCaptureQueued && this.diagnosticTexture && this.diagnosticStagingBuffer && this.diagnosticReadCallback) {
      if (persistDiagnostic) {
        this.encodeDiagnosticBlit(enc, persistDiagnostic);
      }

      const sz = GpuReadback.DIAGNOSTIC_SIZE;
      enc.copyTextureToBuffer(
        { texture: this.diagnosticTexture },
        { buffer: this.diagnosticStagingBuffer, bytesPerRow: sz * 4 },
        [sz, sz, 1],
      );
      this.diagnosticCaptureQueued = false;
      diagnostic = true;
    }

    return { preview, diagnostic };
  }

  afterSubmit(flags: { preview: boolean; diagnostic: boolean }): void {
    if (flags.preview) this.beginPreviewReadback();
    if (flags.diagnostic) this.beginDiagnosticReadback();
  }

  async readTexturePixels(
    texture: GPUTexture,
    width: number,
    height: number,
  ): Promise<ExportTracerResult | null> {
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const staging = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture },
      { buffer: staging, bytesPerRow },
      [width, height, 1],
    );
    this.device.queue.submit([enc.finish()]);

    try {
      await staging.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(staging.getMappedRange());
      const packed = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        const srcOffset = y * bytesPerRow;
        const dstOffset = y * width * 4;
        packed.set(mapped.subarray(srcOffset, srcOffset + width * 4), dstOffset);
      }
      staging.unmap();
      staging.destroy();
      return { width, height, data: packed };
    } catch {
      staging.destroy();
      return null;
    }
  }

  async exportTracerView(
    tracerInspect: TracerInspectPass,
    ctx: {
      persistAbove: GPUTexture;
      persistBelow: GPUTexture;
      layerTextures: [GPUTexture, GPUTexture, GPUTexture];
      pingPong: 0 | 1;
    },
    options: ExportTracerOptions,
  ): Promise<ExportTracerResult | null> {
    const width = Math.max(1, Math.floor(options.width ?? ctx.persistAbove.width));
    const height = Math.max(1, Math.floor(options.height ?? ctx.persistAbove.height));
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const output = this.device.createTexture({
      size: [width, height, 1],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const staging = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const enc = this.device.createCommandEncoder();
    tracerInspect.encodeTracerView(
      enc,
      output.createView(),
      {
        canvasWidth: width,
        canvasHeight: height,
        tracerAboveOpacity: options.tracerAboveOpacity,
        tracerBelowOpacity: options.tracerBelowOpacity,
        tracerBlendMode: options.tracerBlendMode,
        inspectZoom: options.inspectZoom,
        inspectPanX: options.inspectPanX,
        inspectPanY: options.inspectPanY,
        showHeatmap: options.showHeatmap,
        exposure: options.exposure,
        applyTonemap: options.applyTonemap,
        showLayers: options.showLayers,
        layerBlendMode: options.layerBlendMode,
        layerOpacity0: options.layerOpacity0,
        layerOpacity1: options.layerOpacity1,
        layerOpacity2: options.layerOpacity2,
      },
      {
        layerTextures: ctx.layerTextures,
        persistAbove: ctx.persistAbove,
        persistBelow: ctx.persistBelow,
        pingPong: ctx.pingPong,
      },
    );
    enc.copyTextureToBuffer(
      { texture: output },
      { buffer: staging, bytesPerRow },
      [width, height, 1],
    );
    this.device.queue.submit([enc.finish()]);

    try {
      await staging.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(staging.getMappedRange());
      const packed = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        const srcOffset = y * bytesPerRow;
        const dstOffset = y * width * 4;
        packed.set(mapped.subarray(srcOffset, srcOffset + width * 4), dstOffset);
      }
      staging.unmap();
      output.destroy();
      staging.destroy();
      return { width, height, data: packed };
    } catch {
      output.destroy();
      staging.destroy();
      return null;
    }
  }

  destroy(): void {
    this.previewTexture?.destroy();
    this.previewStagingBuffer?.destroy();
    this.diagnosticTexture?.destroy();
    this.diagnosticStagingBuffer?.destroy();
  }

  private ensurePreviewResources(): void {
    if (this.previewTexture && this.previewStagingBuffer) return;

    const sz = GpuReadback.PREVIEW_SIZE;
    this.previewTexture = this.device.createTexture({
      size: [sz, sz, 1],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.previewStagingBuffer = this.device.createBuffer({
      size: sz * sz * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  private ensureDiagnosticResources(): void {
    if (this.diagnosticTexture && this.diagnosticStagingBuffer) return;

    const sz = GpuReadback.DIAGNOSTIC_SIZE;
    this.diagnosticTexture = this.device.createTexture({
      size: [sz, sz, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.diagnosticStagingBuffer = this.device.createBuffer({
      size: sz * sz * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  private encodeDiagnosticBlit(enc: GPUCommandEncoder, persistDiagnostic: GPUTexture): void {
    const bg = getOrCreateSimpleTextureBindGroup(
      this.device,
      this.diagnosticBlitBindGroupCache,
      this.persistDiagnosticBlitBGL,
      this.persistDiagnosticSampler,
      persistDiagnostic,
      [
        { binding: 0, resource: this.persistDiagnosticSampler },
        { binding: 1, resource: persistDiagnostic.createView() },
      ],
    );

    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.diagnosticTexture!.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    pass.setPipeline(this.persistDiagnosticBlitPipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  private beginPreviewReadback(): void {
    if (!this.previewStagingBuffer || !this.previewReadCallback || this.previewReadPending) return;
    const callback = this.previewReadCallback;
    this.previewReadCallback = null;
    this.previewReadPending = true;
    this.previewStagingBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const mapped = this.previewStagingBuffer!.getMappedRange() as ArrayBuffer;
      const data = new Uint8ClampedArray(mapped.slice(0) as ArrayBuffer);
      this.previewStagingBuffer!.unmap();
      this.previewReadPending = false;
      callback(data);
    }).catch(() => {
      this.previewReadPending = false;
      this.previewReadCallback = null;
    });
  }

  private beginDiagnosticReadback(): void {
    if (!this.diagnosticStagingBuffer || !this.diagnosticReadCallback || this.diagnosticReadPending) return;
    const callback = this.diagnosticReadCallback;
    this.diagnosticReadCallback = null;
    this.diagnosticReadPending = true;
    this.diagnosticStagingBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const mapped = new Uint8Array(this.diagnosticStagingBuffer!.getMappedRange());
      const stats: CollisionStats = {
        sampledPixels: GpuReadback.DIAGNOSTIC_SIZE * GpuReadback.DIAGNOSTIC_SIZE,
        twoOverlapPixels: 0,
        threeOverlapPixels: 0,
        dominantLayerWins: [0, 0, 0],
        averageCollision: 0,
      };
      let collisionSum = 0;
      for (let i = 0; i < mapped.length; i += 4) {
        const r = mapped[i] / 255;
        const g = mapped[i + 1] / 255;
        const a = mapped[i + 3] / 255;
        collisionSum += a;
        if (a > 0.5) {
          if (g >= 0.75) {
            stats.threeOverlapPixels += 1;
          } else {
            stats.twoOverlapPixels += 1;
          }
          if (r < 0.33) {
            stats.dominantLayerWins[0] += 1;
          } else if (r < 0.66) {
            stats.dominantLayerWins[1] += 1;
          } else {
            stats.dominantLayerWins[2] += 1;
          }
        }
      }
      stats.averageCollision = collisionSum / stats.sampledPixels;
      this.diagnosticStagingBuffer!.unmap();
      this.diagnosticReadPending = false;
      callback(stats);
    }).catch(() => {
      this.diagnosticReadPending = false;
      this.diagnosticReadCallback = null;
    });
  }
}
