import { bindGroupSlot, cachedBindGroup, type LayerTextures } from './bindGroups';
import type { CollisionStats } from '../types/RendererState';
import {
  COLLISION_STATS_SIZE,
  CollisionStatsRequest,
  collisionStatsFromPixels,
  type CollisionSample,
} from '../collisionStats';
import type { ExportTracerOptions, ExportTracerResult } from '../types/RendererContracts';
import type { TracerInspectPass } from './TracerInspectPass';
import type { WebGPUPipelines } from './WebGPUPipelines';

/**
 * Tightly packed RGBA bytes from a mapped `copyTextureToBuffer` of a 4-byte
 * texture: strips the 256-byte row padding and, for a `bgra*` texture, swaps
 * R and B.
 *
 * Every consumer (PNG and video export, the stationary previews) reads the
 * result as RGBA. The offscreen targets render in the canvas's preferred
 * format, which desktop Chrome reports as `bgra8unorm` on Windows and macOS,
 * and the copy is byte-for-byte — so without the swap a red export came out blue.
 */
export function packRgbaRows(
  mapped: Uint8Array,
  bytesPerRow: number,
  width: number,
  height: number,
  format: GPUTextureFormat,
): Uint8ClampedArray<ArrayBuffer> {
  const rowBytes = width * 4;
  const packed = new Uint8ClampedArray(rowBytes * height);
  for (let y = 0; y < height; y++) {
    packed.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
  }
  if (format.startsWith('bgra')) {
    for (let i = 0; i < packed.length; i += 4) {
      const b = packed[i]!;
      packed[i] = packed[i + 2]!;
      packed[i + 2] = b;
    }
  }
  return packed;
}

export class GpuReadback {
  static readonly DIAGNOSTIC_SIZE = COLLISION_STATS_SIZE;

  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  /** `null` until the device has compiled it; no collision-stats capture runs before. */
  private persistDiagnosticBlitPipeline: GPURenderPipeline | null = null;
  private readonly persistDiagnosticBlitBGL: GPUBindGroupLayout;
  private readonly persistDiagnosticSampler: GPUSampler;
  private readonly diagnosticBlitBindGroup = bindGroupSlot();

  private diagnosticTexture: GPUTexture | null = null;
  private diagnosticStagingBuffer: GPUBuffer | null = null;
  private diagnosticReadPending = false;
  private diagnosticCaptureQueued = false;
  private readonly stats = new CollisionStatsRequest();

  constructor(device: GPUDevice, format: GPUTextureFormat, pipelines: WebGPUPipelines) {
    this.device = device;
    this.format = format;
    this.persistDiagnosticBlitBGL = pipelines.persistDiagnosticBlitBGL;
    // Compiled off the frame, not in the constructor: a renderer is built
    // outside any error scope for the compare and quad slots.
    pipelines.createPersistDiagnosticBlitPipeline().then(
      (pipeline) => { this.persistDiagnosticBlitPipeline = pipeline; },
      (error: unknown) => { console.error('[GpuReadback] Collision-stats blit unavailable:', error); },
    );
    this.persistDiagnosticSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /**
   * @param layerCount  Layers the frame being sampled was rendered with — the
   *   diagnostic red channel encodes the dominant layer as `index / (n - 1)`,
   *   so decoding it back to an index needs the same `n`.
   */
  requestCollisionStats(
    callback: (stats: CollisionStats) => void,
    layerCount: number,
  ): boolean {
    if (this.diagnosticReadPending || this.diagnosticCaptureQueued) return false;
    if (!this.stats.request(callback, layerCount)) return false;
    this.diagnosticCaptureQueued = true;
    return true;
  }

  /** Encode the collision-stats blit + copy if one is queued; returns whether it was. */
  encodeQueuedReadbacks(
    enc: GPUCommandEncoder,
    persistDiagnostic: GPUTexture | null,
  ): boolean {
    if (this.diagnosticCaptureQueued && !this.diagnosticReadPending) {
      this.ensureDiagnosticResources();
    }
    if (!this.diagnosticCaptureQueued || !this.diagnosticTexture || !this.diagnosticStagingBuffer
      || !this.stats.outstanding) {
      return false;
    }
    if (persistDiagnostic) {
      // Stays queued until the blit has compiled.
      if (!this.persistDiagnosticBlitPipeline) return false;
      this.encodeDiagnosticBlit(enc, persistDiagnostic, this.persistDiagnosticBlitPipeline);
    }

    const sz = GpuReadback.DIAGNOSTIC_SIZE;
    enc.copyTextureToBuffer(
      { texture: this.diagnosticTexture },
      { buffer: this.diagnosticStagingBuffer, bytesPerRow: sz * 4 },
      [sz, sz, 1],
    );
    this.diagnosticCaptureQueued = false;
    return true;
  }

  afterSubmit(diagnosticEncoded: boolean): void {
    if (diagnosticEncoded) this.beginDiagnosticReadback();
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
      const data = packRgbaRows(new Uint8Array(staging.getMappedRange()), bytesPerRow, width, height, texture.format);
      staging.unmap();
      staging.destroy();
      return { width, height, data };
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
      layerTextures: LayerTextures;
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
        layerOpacities: options.layerOpacities,
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
      const data = packRgbaRows(new Uint8Array(staging.getMappedRange()), bytesPerRow, width, height, output.format);
      staging.unmap();
      output.destroy();
      staging.destroy();
      return { width, height, data };
    } catch {
      output.destroy();
      staging.destroy();
      return null;
    }
  }

  destroy(): void {
    this.diagnosticTexture?.destroy();
    this.diagnosticStagingBuffer?.destroy();
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

  private encodeDiagnosticBlit(
    enc: GPUCommandEncoder,
    persistDiagnostic: GPUTexture,
    pipeline: GPURenderPipeline,
  ): void {
    const bg = cachedBindGroup(
      this.device,
      this.diagnosticBlitBindGroup,
      this.persistDiagnosticBlitBGL,
      [persistDiagnostic],
      () => [
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
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(6);
    pass.end();
  }

  private beginDiagnosticReadback(): void {
    if (!this.diagnosticStagingBuffer || !this.stats.outstanding || this.diagnosticReadPending) return;
    this.diagnosticReadPending = true;
    this.diagnosticStagingBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const mapped = new Uint8Array(this.diagnosticStagingBuffer!.getMappedRange());
      const { layerCount } = this.stats;
      const stats = collisionStatsFromPixels(mapped, layerCount, decodePersistDiagnostic(layerCount));
      this.diagnosticStagingBuffer!.unmap();
      this.diagnosticReadPending = false;
      this.stats.settle(stats);
    }).catch(() => {
      this.diagnosticReadPending = false;
      this.stats.drop();
    });
  }
}

/**
 * The persistence diagnostic, blitted down: alpha is the collision, green
 * the overlap depth, red the dominant layer as `index / (layerCount - 1)`.
 * At the default three layers this puts the same pixels in the same buckets
 * as the 0.33 / 0.66 thresholds it replaced.
 */
function decodePersistDiagnostic(layerCount: number) {
  const dominantScale = Math.max(1, layerCount - 1);
  return (r: number, g: number, _b: number, a: number): CollisionSample => {
    if (a / 255 <= 0.5) return { collision: a / 255, overlap: 'none', dominantLayer: null };
    return {
      collision: a / 255,
      overlap: g / 255 >= 0.75 ? 'full' : 'partial',
      dominantLayer: Math.min(Math.round((r / 255) * dominantScale), layerCount - 1),
    };
  };
}
