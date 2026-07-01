import {
  fragmentShaderRedOrange,
  fragmentShaderVioletBlue,
  fragmentShaderGreenYellow
} from './shaders';
import { WebGPUPipelines, type LayerPipeline } from './WebGPUPipelines';
/**
 * WebGPURenderer
 *
 * 5-pass rendering pipeline:
 *   Pass 0–2 : Each colour layer → its own intermediate GPUTexture
 *   Pass 3   : Persistence pass — detects 2+ layer overlap, writes mixed
 *              colour into ping-pong buffer, decays previous hits
 *   Pass 4   : Compositor — live layers + persistence overlay → canvas
 */

import { MAIN_VIEW_MODES } from './viewModes';

export interface LayerState {
  angleDeg : number;
  flipX?   : boolean;
  flipY?   : boolean;
}

export interface RendererState {
  layers               : [LayerState, LayerState, LayerState];
  avgLuminance         : number;
  layerOpacity?        : number;
  layerOpacities?      : [number, number, number];
  layerScale?          : number;  // 0.1–2.0, default 1.0
  tracerScale?         : number;  // 0.1–2.0, default 1.0
  tracerAboveIntensity?: number;  // NEW
  tracerBelowIntensity?: number;  // NEW
  tracerAboveDuration? : number;  // NEW
  tracerBelowDuration? : number;  // NEW
  tracerThreshold?     : number;
  tracerMode?          : number;  // 0 = combined colors, 1 = grey highlight
  colorMode?           : number;  // 0 = Fixed (cr0p), 1 = Vivid (Chromashift gradient), 2 = CROP, 3 = CROP NUNIF2
  sobelEnabled?        : boolean; // Sobel edge boost on luminance before band assignment
  softCropEnabled?     : boolean; // Soft band edges in CROP / NUNIF2 (hard cuts when false)
  layerBlendMode?      : number;  // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen, 5=lighten, 6=darken, 7=overlay, 8=color dodge, 9=color burn, 10=difference, 11=exclusion, 12=hard light
  tracerBlendMode?     : number;  // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen, 5=lighten, 6=darken, 7=overlay, 8=color dodge, 9=color burn, 10=difference, 11=exclusion, 12=hard light
  outputMode?          : number;  // 0 = mixed, 1 = tracer focus, 2 = tracer only
  paused?              : boolean; // When true, tracer persistence stops decaying
  showTracerView?      : boolean; // When true, main canvas shows the persistence (tracer) buffer centered at native res instead of the normal compositor output
  mainViewMode?        : number;  // 0 = composite, 1 = tracer, 2 = source, 3-5 = layers, 6 = heatmap, 7 = compare
  tracerInspectZoom?   : number;
  tracerInspectPanX?   : number;
  tracerInspectPanY?   : number;
  tracerInspectHeatmap?: boolean;
  tracerInspectExposure? : number;
  tracerInspectTonemap?: boolean;
  tracerInspectShowLayers?: boolean;
  diagnosticsMode?     : boolean;
  diagnosticsOpacity?  : number;
  stampBoost?          : number;
  peakCollisionsOnly?  : boolean;
  webglDebugMode?      : number;  // WebGL-only: 0=normal, 1=luminance, 2=rotation UV, 3=mask
  viewportQuarterZoom? : boolean; // Magnify bottom-left quarter of compositor output to full canvas
}

export interface CollisionStats {
  sampledPixels: number;
  twoOverlapPixels: number;
  threeOverlapPixels: number;
  dominantLayerWins: [number, number, number];
  averageCollision: number;
}

/**
 * Compute the average ITU-R BT.709 luminance of an image.
 * Returns a value in the range 0–255.
 */
export function computeAverageLuminance(image: HTMLImageElement): number {
  const canvas = document.createElement('canvas');
  // Downsample to avoid a full-resolution CPU readback on large images.
  // 256 px on the long edge is plenty for a stable mean estimate.
  const MAX_SIZE = 256;
  const scale = Math.min(1, MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
  canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return 128;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sum += r * 0.2126 + g * 0.7152 + b * 0.0722;
  }
  return sum / (data.length / 4);
}

/**
 * Convert tracerDuration (ms) and frameRate (fps) into a per-frame
 * decay multiplier so that after `duration` ms the value reaches ~1/255.
 *
 * decay^(fps * duration/1000) = 1/255
 * decay = (1/255) ^ (1000 / (fps * duration))
 */
function durationToDecay(durationMs: number, fps: number): number {
  if (durationMs <= 0) return 0.0;
  const frames = fps * durationMs / 1000;
  if (frames < 1) return 0.0;
  // Decay to 0.1 (10% visibility) instead of 1/255 for a more visible tracer
  return Math.pow(0.1, 1 / frames);
}

interface LayerBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  texture: GPUTexture | null;
  maskTexture: GPUTexture | null;
}

interface TexturePairBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  layer0: GPUTexture | null;
  layer1: GPUTexture | null;
  layer2: GPUTexture | null;
  textureA: object | null;
  textureB: object | null;
}

interface HeatmapBindGroupCacheEntry {
  bindGroup: GPUBindGroup | null;
  layer0: GPUTexture | null;
  layer1: GPUTexture | null;
  layer2: GPUTexture | null;
  uniformBuf: GPUBuffer | null;
}

export class WebGPURenderer {
  readonly backend = 'webgpu' as const;
  /** Size of the composited preview texture (fixed, independent of canvas/tracerScale). */
  static readonly PREVIEW_SIZE = 128;
  static readonly DIAGNOSTIC_SIZE = 64;

  private device         : GPUDevice;
  private context        : GPUCanvasContext;
  private format         : GPUTextureFormat;
  /** HDR format used for all intermediate textures (layers, persistence, MSAA).
   *  rgba16float is renderable + blendable in WebGPU core — no feature flag needed. */
  private internalFormat : GPUTextureFormat = 'rgba16float';
  public pipelines: WebGPUPipelines;
  public sampler        : GPUSampler;
  private sampleCount    : number = 4;

  // Layer passes
  private layerPipelines : LayerPipeline[] = [];
  private currentTexture : GPUTexture | null = null;
  private classificationMaskTexture: GPUTexture | null = null;
  private fallbackMaskTexture: GPUTexture;

  // Intermediate per-layer render textures (scaled by layerScale)
  private layerTextures : GPUTexture[] = [];
  private msaaTexture   : GPUTexture | null = null;
  private texW = 0;
  private texH = 0;
  private currentLayerScale = 1.0;
  private currentTracerScale = 1.0;
  private layerScale = 1.0;
  private tracerScale = 1.0;

  // Persistence ping-pong (Dual system)
  private persistAboveTextures  : [GPUTexture | null, GPUTexture | null] = [null, null];
  private persistBelowTextures  : [GPUTexture | null, GPUTexture | null] = [null, null];
  private persistDiagnosticTextures: [GPUTexture | null, GPUTexture | null] = [null, null];
  private persistPingPong       : 0 | 1 = 0;  // shared index
  private persistPipeline       : GPURenderPipeline;
  private persistBGL            : GPUBindGroupLayout;
  private persistAboveUniformBuf: GPUBuffer;
  private persistBelowUniformBuf: GPUBuffer;
  private persistUniformData = new ArrayBuffer(32);
  private persistF32 = new Float32Array(this.persistUniformData);
  private persistU32 = new Uint32Array(this.persistUniformData);

  // Compositor
  private compositorPipeline  : GPURenderPipeline;
  private compositorBGL       : GPUBindGroupLayout;
  private compositorSampler   : GPUSampler;
  private compositorUniformBuf: GPUBuffer;

  // ── Tracer View (full-res centered inspection of persistence buffers) ──────
  /** Pipeline + resources for the dedicated "Show Full Tracer" display path.
   *  Renders both persistence buffers (Above + Below) with the user's current
   *  intensity/blend settings and the same Reinhard tonemap as the compositor,
   *  with aspect-fit letterboxing for non-1.0 tracerScale values. */
  private tracerViewPipeline  : GPURenderPipeline;
  private tracerViewBGL       : GPUBindGroupLayout;
  private tracerViewUniformBuf: GPUBuffer;
  private tracerViewSampler   : GPUSampler;
  private displayPipeline     : GPURenderPipeline;
  private displayBGL          : GPUBindGroupLayout;
  private displayUniformBuf   : GPUBuffer;
  private heatmapPipeline     : GPURenderPipeline;
  private heatmapBGL          : GPUBindGroupLayout;
  private heatmapUniformBuf   : GPUBuffer;

  private comparePipeline     : GPURenderPipeline;
  private compareBGL          : GPUBindGroupLayout;
  private compareUniformBuf   : GPUBuffer;

  // Persist diagnostic blit (for CPU readback) + stamp diagnostic view
  private persistDiagnosticBlitPipeline  : GPURenderPipeline;
  private persistDiagnosticBlitBGL       : GPUBindGroupLayout;
  private persistDiagnosticSampler       : GPUSampler;
  private stampDiagnosticViewPipeline    : GPURenderPipeline;
  private stampDiagnosticViewBGL         : GPUBindGroupLayout;
  private stampDiagnosticViewSampler     : GPUSampler;

  // Small composited preview — fixed 256×256, independent of canvas/tracerScale
  private previewTexture      : GPUTexture | null = null;
  private previewStagingBuffer: GPUBuffer | null = null;
  private previewReadPending  = false;
  private previewCaptureQueued = false;
  private previewReadCallback: ((data: Uint8ClampedArray<ArrayBuffer>) => void) | null = null;
  private diagnosticTexture: GPUTexture | null = null;
  private diagnosticStagingBuffer: GPUBuffer | null = null;
  private diagnosticReadPending = false;
  private diagnosticCaptureQueued = false;
  private diagnosticReadCallback: ((stats: CollisionStats) => void) | null = null;
  private layerBindGroupCache: LayerBindGroupCacheEntry[] = [0, 1, 2].map(() => ({
    bindGroup: null,
    texture: null,
    maskTexture: null,
  }));
  private persistBelowBindGroupCache: TexturePairBindGroupCacheEntry[] = [0, 1].map(() => ({
    bindGroup: null,
    layer0: null,
    layer1: null,
    layer2: null,
    textureA: null,
    textureB: null,
  }));
  private persistAboveBindGroupCache: TexturePairBindGroupCacheEntry[] = [0, 1].map(() => ({
    bindGroup: null,
    layer0: null,
    layer1: null,
    layer2: null,
    textureA: null,
    textureB: null,
  }));
  private compositorBindGroupCache: TexturePairBindGroupCacheEntry[] = [0, 1].map(() => ({
    bindGroup: null,
    layer0: null,
    layer1: null,
    layer2: null,
    textureA: null,
    textureB: null,
  }));
  private tracerViewBindGroupCache: TexturePairBindGroupCacheEntry[] = [0, 1].map(() => ({
    bindGroup: null,
    layer0: null,
    layer1: null,
    layer2: null,
    textureA: null,
    textureB: null,
  }));
  private heatmapBindGroupCache: HeatmapBindGroupCacheEntry = {
    bindGroup: null,
    layer0: null,
    layer1: null,
    layer2: null,
    uniformBuf: null,
  };
  private lastRenderCpuMs = 0;
  private averageRenderCpuMs = 0;

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, enableMSAA = false) {
    this.device  = device;
    this.context = context;
    this.format  = format;
    this.sampleCount = enableMSAA ? 4 : 1;
    this.pipelines = new WebGPUPipelines(device, format, this.internalFormat);

    // High-quality sampler for the source image.
    // - linear min/mag + mipmap linear: reduces aliasing during rotation/minification
    //   (especially once mipmaps are generated on upload — see TextureManager).
    // - explicit clamp-to-edge: prevents wrap-around artifacts at image borders
    //   when layers rotate the UVs outside [0,1].
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.fallbackMaskTexture = device.createTexture({
      size: [1, 1, 1],
      format: 'r8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.fallbackMaskTexture },
      new Uint8Array([0]),
      { bytesPerRow: 1, rowsPerImage: 1 },
      [1, 1, 1],
    );

    const fragSources = [fragmentShaderRedOrange, fragmentShaderVioletBlue, fragmentShaderGreenYellow];
    for (const src of fragSources) this.layerPipelines.push(this.pipelines.createLayerPipeline(src));

    // Sampler used for all intermediate layer + persistence textures.
    // These are same-resolution render targets (no mips), so mipmapFilter is irrelevant.
    // Linear gives smooth blending of the decaying tracers.
    this.compositorSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Persistence pipeline
    this.persistBGL      = this.pipelines.persistBGL;
    this.persistPipeline = this.pipelines.createPersistPipeline();
    this.persistAboveUniformBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.persistBelowUniformBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // Compositor pipeline
    this.compositorBGL      = this.pipelines.compositorBGL;
    this.compositorPipeline = this.pipelines.createCompositorPipeline();
    this.compositorUniformBuf = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Tracer View pipeline (aspect-fit blit of both persistence textures)
    this.tracerViewBGL      = this.pipelines.tracerViewBGL;
    this.tracerViewPipeline = this.pipelines.createTracerViewPipeline();
    this.tracerViewUniformBuf = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.tracerViewSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest', // persistence textures have no mips
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.displayBGL = this.pipelines.displayBGL;
    this.displayPipeline = this.pipelines.createDisplayPipeline();
    this.displayUniformBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.heatmapBGL = this.pipelines.heatmapBGL;
    this.heatmapPipeline = this.pipelines.createHeatmapPipeline();
    this.heatmapUniformBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.compareBGL = this.pipelines.compareBGL;
    this.comparePipeline = this.pipelines.createComparePipeline();
    this.compareUniformBuf = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Persist diagnostic blit pipeline (nearest sampler to preserve encoded values)
    this.persistDiagnosticBlitBGL = this.pipelines.persistDiagnosticBlitBGL;
    this.persistDiagnosticBlitPipeline = this.pipelines.createPersistDiagnosticBlitPipeline();
    this.persistDiagnosticSampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Stamp diagnostic view pipeline
    this.stampDiagnosticViewBGL = this.pipelines.stampDiagnosticViewBGL;
    this.stampDiagnosticViewPipeline = this.pipelines.createStampDiagnosticViewPipeline();
    this.stampDiagnosticViewSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  private compositorUniformData = new ArrayBuffer(64);
  private compositorF32 = new Float32Array(this.compositorUniformData);
  private compositorU32 = new Uint32Array(this.compositorUniformData);

  // Tracer view uniform
  private tracerViewUniformData = new ArrayBuffer(80);
  private tracerViewF32 = new Float32Array(this.tracerViewUniformData);
  private tracerViewU32 = new Uint32Array(this.tracerViewUniformData);
  private displayUniformData = new ArrayBuffer(16);
  private displayF32 = new Float32Array(this.displayUniformData);
  private displayU32 = new Uint32Array(this.displayUniformData);
  private heatmapUniformData = new ArrayBuffer(16);
  private heatmapF32 = new Float32Array(this.heatmapUniformData);
  private compareUniformData = new ArrayBuffer(48);
  private compareF32 = new Float32Array(this.compareUniformData);
  private compareU32 = new Uint32Array(this.compareUniformData);

  getRenderTiming(): { lastCpuMs: number; averageCpuMs: number } {
    return { lastCpuMs: this.lastRenderCpuMs, averageCpuMs: this.averageRenderCpuMs };
  }

  private invalidateBindGroupCaches(): void {
    for (const entry of this.layerBindGroupCache) {
      entry.bindGroup = null;
      entry.texture = null;
      entry.maskTexture = null;
    }
    for (const entries of [
      this.persistBelowBindGroupCache,
      this.persistAboveBindGroupCache,
      this.compositorBindGroupCache,
      this.tracerViewBindGroupCache,
    ]) {
      for (const entry of entries) {
        entry.bindGroup = null;
        entry.layer0 = null;
        entry.layer1 = null;
        entry.layer2 = null;
        entry.textureA = null;
        entry.textureB = null;
      }
    }
    this.heatmapBindGroupCache.bindGroup = null;
    this.heatmapBindGroupCache.layer0 = null;
    this.heatmapBindGroupCache.layer1 = null;
    this.heatmapBindGroupCache.layer2 = null;
    this.heatmapBindGroupCache.uniformBuf = null;
  }

  // ─── Persistence pipeline ────────────────────────────────────────────────────


  // ─── Compositor pipeline ─────────────────────────────────────────────────────


  // ── Tracer View pipeline helpers (for "Show Full Tracer" button) ────────────


  private encodeTracerViewPass(
    enc: GPUCommandEncoder,
    targetView: GPUTextureView,
    canvasWidth: number,
    canvasHeight: number,
    tracerAboveOpacity: number,
    tracerBelowOpacity: number,
    tracerBlendMode: number,
    inspectZoom = 1,
    inspectPanX = 0,
    inspectPanY = 0,
    showHeatmap = false,
    exposure = 1.04,
    applyTonemap = true,
    showLayers = false,
    layerBlendMode = 0,
    layerOpacity0 = 1,
    layerOpacity1 = 1,
    layerOpacity2 = 1,
  ): void {
    const pTexAbove = this.persistAboveTextures[this.persistPingPong];
    const pTexBelow = this.persistBelowTextures[this.persistPingPong];
    if (!pTexAbove || !pTexBelow) return;

    const tW = pTexAbove.width;
    const tH = pTexAbove.height;

    this.tracerViewF32[0] = canvasWidth / Math.max(1, canvasHeight);
    this.tracerViewF32[1] = tW / Math.max(1, tH);
    this.tracerViewF32[2] = tracerAboveOpacity;
    this.tracerViewF32[3] = tracerBelowOpacity;
    this.tracerViewU32[4] = tracerBlendMode;
    this.tracerViewU32[5] = showHeatmap ? 1 : 0;
    this.tracerViewF32[6] = Math.max(1, inspectZoom);
    this.tracerViewF32[7] = inspectPanX;
    this.tracerViewF32[8] = inspectPanY;
    this.tracerViewF32[9] = 0.82;
    this.tracerViewF32[10] = exposure;
    this.tracerViewU32[11] = applyTonemap ? 1 : 0;
    this.tracerViewU32[12] = showLayers ? 1 : 0;
    this.tracerViewU32[13] = layerBlendMode;
    this.tracerViewF32[14] = layerOpacity0;
    this.tracerViewF32[15] = layerOpacity1;
    this.tracerViewF32[16] = layerOpacity2;
    this.device.queue.writeBuffer(this.tracerViewUniformBuf, 0, this.tracerViewUniformData);

    const tvBG = this.getTracerViewBindGroup();

    const tvPass = enc.beginRenderPass({
      colorAttachments: [{
        view      : targetView,
        loadOp    : 'clear',
        storeOp   : 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    tvPass.setPipeline(this.tracerViewPipeline);
    tvPass.setBindGroup(0, tvBG);
    tvPass.draw(6);
    tvPass.end();
  }







  // ─── Persist diagnostic blit pipeline (for CPU readback) ─────────────────────


  // ─── Stamp diagnostic view pipeline (dominant-layer colour map) ──────────────


  // ─── Texture management ──────────────────────────────────────────────────────
  private ensureTextures(w: number, h: number): void {
    // Check if both dimensions AND scales are identical
    if (this.texW === w && this.texH === h &&
        this.currentLayerScale === this.layerScale &&
        this.currentTracerScale === this.tracerScale &&
        this.layerTextures.length === 3) return;

    this.currentLayerScale = this.layerScale;
    this.currentTracerScale = this.tracerScale;

    // Destroy old textures
    for (const t of this.layerTextures) t.destroy();
    this.msaaTexture?.destroy();
    this.persistAboveTextures[0]?.destroy(); this.persistAboveTextures[1]?.destroy();
    this.persistBelowTextures[0]?.destroy(); this.persistBelowTextures[1]?.destroy();
    this.persistDiagnosticTextures[0]?.destroy(); this.persistDiagnosticTextures[1]?.destroy();

    const layerW = Math.max(1, Math.round(w * this.layerScale));
    const layerH = Math.max(1, Math.round(h * this.layerScale));
    const tracerW = Math.max(1, Math.round(w * this.tracerScale));
    const tracerH = Math.max(1, Math.round(h * this.tracerScale));

    // Layer intermediate textures (scaled by layerScale)
    this.layerTextures = [0, 1, 2].map(() => this.device.createTexture({
      size       : [layerW, layerH, 1],
      format     : this.internalFormat,
      usage      : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      sampleCount: 1,
    }));

    // MSAA resolve target (must match layer texture resolution, NOT canvas resolution)
    if (this.sampleCount > 1) {
      this.msaaTexture = this.device.createTexture({
        size       : [layerW, layerH, 1],
        format     : this.internalFormat,
        sampleCount: this.sampleCount,
        usage      : GPUTextureUsage.RENDER_ATTACHMENT,
      });
    } else {
      this.msaaTexture = null;
    }

    // Persistence ping-pong textures — scaled by tracerScale
    const createPersistTex = () => this.device.createTexture({
      size  : [tracerW, tracerH, 1], format: this.internalFormat,
      usage : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    this.persistAboveTextures = [createPersistTex(), createPersistTex()] as [GPUTexture, GPUTexture];
    this.persistBelowTextures = [createPersistTex(), createPersistTex()] as [GPUTexture, GPUTexture];

    const createDiagnosticTex = () => this.device.createTexture({
      size  : [tracerW, tracerH, 1], format: 'rgba8unorm',
      usage : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.persistDiagnosticTextures = [createDiagnosticTex(), createDiagnosticTex()] as [GPUTexture, GPUTexture];

    this.persistPingPong = 0;
    this.texW = w;
    this.texH = h;
    this.invalidateBindGroupCaches();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────
  setTexture(texture: unknown): void {
    this.currentTexture = texture as GPUTexture;
    for (const entry of this.layerBindGroupCache) {
      entry.bindGroup = null;
      entry.texture = null;
    }
  }

  setClassificationMaskTexture(texture: GPUTexture | null): void {
    this.classificationMaskTexture = texture;
    for (const entry of this.layerBindGroupCache) {
      entry.bindGroup = null;
      entry.maskTexture = null;
    }
  }

  setAntialiasing(enabled: boolean): void {
    const next = enabled ? 4 : 1;
    if (next === this.sampleCount) return;
    this.sampleCount = next;

    // Rebuild layer pipelines with new sample count
    this.layerPipelines = [];
    for (const src of [fragmentShaderRedOrange, fragmentShaderVioletBlue, fragmentShaderGreenYellow]) {
      this.layerPipelines.push(this.pipelines.createLayerPipeline(src));
    }

    // Force texture recreation
    for (const t of this.layerTextures) t.destroy();
    this.layerTextures = [];
    this.msaaTexture?.destroy();
    this.msaaTexture = null;
    this.persistAboveTextures[0]?.destroy(); this.persistAboveTextures[1]?.destroy();
    this.persistBelowTextures[0]?.destroy(); this.persistBelowTextures[1]?.destroy();
    this.persistDiagnosticTextures[0]?.destroy(); this.persistDiagnosticTextures[1]?.destroy();
    this.persistAboveTextures = [null, null];
    this.persistBelowTextures = [null, null];
    this.persistDiagnosticTextures = [null, null];
    this.texW = 0;
    this.texH = 0;
    this.layerScale = 1.0;
    this.tracerScale = 1.0;
    this.invalidateBindGroupCaches();
  }

  /**
   * Get the current persistence texture (the accumulated layer overlaps).
   * Returns null if textures haven't been initialized yet.
   * @deprecated Use requestPreviewReadback() for preview thumbnails.
   */
  getPersistenceTexture(): GPUTexture | null {
    return this.persistAboveTextures[this.persistPingPong];
  }

  // ─── Preview resources ────────────────────────────────────────────────────
  /**
   * Create the fixed-size composited preview texture and its reusable staging
   * buffer.  Called lazily from render() the first time.
   *
   * PREVIEW_SIZE = 128 → bytesPerRow = 128×4 = 512, which is already aligned
   * to the required 256-byte boundary with zero padding.
   */
  private ensurePreviewResources(): void {
    if (this.previewTexture && this.previewStagingBuffer) return;

    const sz = WebGPURenderer.PREVIEW_SIZE;

    this.previewTexture = this.device.createTexture({
      size  : [sz, sz, 1],
      format: this.format,
      usage : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    // bytesPerRow = 128 * 4 = 512 (multiple of 256 ✓, no padding needed)
    this.previewStagingBuffer = this.device.createBuffer({
      size : sz * sz * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  private ensureDiagnosticResources(): void {
    if (this.diagnosticTexture && this.diagnosticStagingBuffer) return;

    const sz = WebGPURenderer.DIAGNOSTIC_SIZE;
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

  /**
   * Queue a single preview capture. The actual compositor preview pass and
   * GPU->CPU copy only happen during the next render() call, so the main render
   * loop avoids preview work entirely when nobody asked for a thumbnail update.
   */
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

  private beginPreviewReadback(): void {
    if (!this.previewStagingBuffer || !this.previewReadCallback || this.previewReadPending) return;
    const callback = this.previewReadCallback;
    this.previewReadCallback = null;
    this.previewReadPending = true;
    this.previewStagingBuffer.mapAsync(GPUMapMode.READ).then(() => {
      const mapped = this.previewStagingBuffer!.getMappedRange() as ArrayBuffer;
      // Copy before unmap so the caller receives a stable buffer.
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
        sampledPixels: WebGPURenderer.DIAGNOSTIC_SIZE * WebGPURenderer.DIAGNOSTIC_SIZE,
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
          // Decode layerCount from green channel: 0.5 = 2-overlap, 1.0 = 3-overlap
          if (g >= 0.75) {
            stats.threeOverlapPixels += 1;
          } else {
            stats.twoOverlapPixels += 1;
          }
          // Decode dominant layer from red channel: 0.0 = L0, 0.5 = L1, 1.0 = L2
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

  /**
   * Clear all persistence textures to transparent black.
   * Call this when changing images to reset the tracer.
   */
  clearPersistence(): void {
    const enc = this.device.createCommandEncoder();
    
    // Clear all persistence and diagnostic textures
    const allTextures = [
      this.persistAboveTextures[0], this.persistAboveTextures[1],
      this.persistBelowTextures[0], this.persistBelowTextures[1],
      this.persistDiagnosticTextures[0], this.persistDiagnosticTextures[1],
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
    this.persistPingPong = 0;
  }

  private getLayerBindGroup(index: number): GPUBindGroup {
    const lp = this.layerPipelines[index];
    const entry = this.layerBindGroupCache[index];
    const maskTexture = this.classificationMaskTexture ?? this.fallbackMaskTexture;
    if (
      entry.bindGroup &&
      entry.texture === this.currentTexture &&
      entry.maskTexture === maskTexture
    ) {
      return entry.bindGroup;
    }

    const bindGroup = this.device.createBindGroup({
      layout : lp.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: lp.rotationBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.currentTexture!.createView() },
        { binding: 3, resource: { buffer: lp.fragUniformBuffer } },
        { binding: 4, resource: maskTexture.createView() },
      ],
    });
    entry.bindGroup = bindGroup;
    entry.texture = this.currentTexture;
    entry.maskTexture = maskTexture;
    return bindGroup;
  }

  private getPersistenceBindGroup(
    cache: TexturePairBindGroupCacheEntry[],
    readIdx: 0 | 1,
    textures: [GPUTexture | null, GPUTexture | null],
    uniformBuf: GPUBuffer,
  ): GPUBindGroup {
    const entry = cache[readIdx];
    const prevTexture = textures[readIdx]!;
    if (
      entry.bindGroup &&
      entry.layer0 === this.layerTextures[0] &&
      entry.layer1 === this.layerTextures[1] &&
      entry.layer2 === this.layerTextures[2] &&
      entry.textureA === prevTexture &&
      entry.textureB === uniformBuf
    ) {
      return entry.bindGroup;
    }

    const bindGroup = this.device.createBindGroup({
      layout : this.persistBGL,
      entries: [
        { binding: 0, resource: this.compositorSampler },
        { binding: 1, resource: this.layerTextures[0].createView() },
        { binding: 2, resource: this.layerTextures[1].createView() },
        { binding: 3, resource: this.layerTextures[2].createView() },
        { binding: 4, resource: prevTexture.createView() },
        { binding: 5, resource: { buffer: uniformBuf } },
      ],
    });
    entry.bindGroup = bindGroup;
    entry.layer0 = this.layerTextures[0];
    entry.layer1 = this.layerTextures[1];
    entry.layer2 = this.layerTextures[2];
    entry.textureA = prevTexture;
    entry.textureB = uniformBuf;
    return bindGroup;
  }

  private getCompositorBindGroup(): GPUBindGroup {
    const entry = this.compositorBindGroupCache[this.persistPingPong];
    const persistBelow = this.persistBelowTextures[this.persistPingPong]!;
    const persistAbove = this.persistAboveTextures[this.persistPingPong]!;
    if (
      entry.bindGroup &&
      entry.layer0 === this.layerTextures[0] &&
      entry.layer1 === this.layerTextures[1] &&
      entry.layer2 === this.layerTextures[2] &&
      entry.textureA === persistBelow &&
      entry.textureB === persistAbove
    ) {
      return entry.bindGroup;
    }

    const bindGroup = this.device.createBindGroup({
      layout : this.compositorBGL,
      entries: [
        { binding: 0, resource: this.compositorSampler },
        { binding: 1, resource: this.layerTextures[0].createView() },
        { binding: 2, resource: this.layerTextures[1].createView() },
        { binding: 3, resource: this.layerTextures[2].createView() },
        { binding: 4, resource: persistBelow.createView() },
        { binding: 5, resource: persistAbove.createView() },
        { binding: 6, resource: { buffer: this.compositorUniformBuf } },
      ],
    });
    entry.bindGroup = bindGroup;
    entry.layer0 = this.layerTextures[0];
    entry.layer1 = this.layerTextures[1];
    entry.layer2 = this.layerTextures[2];
    entry.textureA = persistBelow;
    entry.textureB = persistAbove;
    return bindGroup;
  }

  private getTracerViewBindGroup(): GPUBindGroup {
    const entry = this.tracerViewBindGroupCache[this.persistPingPong];
    const persistAbove = this.persistAboveTextures[this.persistPingPong]!;
    const persistBelow = this.persistBelowTextures[this.persistPingPong]!;
    if (
      entry.bindGroup &&
      entry.layer0 === this.layerTextures[0] &&
      entry.layer1 === this.layerTextures[1] &&
      entry.layer2 === this.layerTextures[2] &&
      entry.textureA === persistAbove &&
      entry.textureB === persistBelow
    ) {
      return entry.bindGroup;
    }

    const bindGroup = this.device.createBindGroup({
      layout : this.tracerViewBGL,
      entries: [
        { binding: 0, resource: this.tracerViewSampler },
        { binding: 1, resource: persistAbove.createView() },
        { binding: 2, resource: persistBelow.createView() },
        { binding: 3, resource: this.layerTextures[0].createView() },
        { binding: 4, resource: this.layerTextures[1].createView() },
        { binding: 5, resource: this.layerTextures[2].createView() },
        { binding: 6, resource: { buffer: this.tracerViewUniformBuf } },
      ],
    });
    entry.bindGroup = bindGroup;
    entry.layer0 = this.layerTextures[0];
    entry.layer1 = this.layerTextures[1];
    entry.layer2 = this.layerTextures[2];
    entry.textureA = persistAbove;
    entry.textureB = persistBelow;
    return bindGroup;
  }

  private getHeatmapBindGroup(): GPUBindGroup {
    return this.getLayerTextureBindGroup(this.heatmapBGL, this.heatmapUniformBuf);
  }

  private getLayerTextureBindGroup(layout: GPUBindGroupLayout, uniformBuf: GPUBuffer): GPUBindGroup {
    const entry = this.heatmapBindGroupCache;
    if (
      entry.bindGroup &&
      entry.layer0 === this.layerTextures[0] &&
      entry.layer1 === this.layerTextures[1] &&
      entry.layer2 === this.layerTextures[2] &&
      entry.uniformBuf === uniformBuf
    ) {
      return entry.bindGroup;
    }

    const bindGroup = this.device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: this.compositorSampler },
        { binding: 1, resource: this.layerTextures[0].createView() },
        { binding: 2, resource: this.layerTextures[1].createView() },
        { binding: 3, resource: this.layerTextures[2].createView() },
        { binding: 4, resource: { buffer: uniformBuf } },
      ],
    });
    entry.bindGroup = bindGroup;
    entry.layer0 = this.layerTextures[0];
    entry.layer1 = this.layerTextures[1];
    entry.layer2 = this.layerTextures[2];
    entry.uniformBuf = uniformBuf;
    return bindGroup;
  }

  render(state: RendererState, fps = 30): void {
    if (!this.currentTexture) return;
    const renderStart = performance.now();

    this.layerScale = state.layerScale ?? 1.0;
    this.tracerScale = state.tracerScale ?? 1.0;

    const canvasTex = this.context.getCurrentTexture();
    this.ensureTextures(canvasTex.width, canvasTex.height);

    const enc = this.device.createCommandEncoder();
    const globalLayerOpacity = state.layerOpacity ?? 1.0;
    const sourceLayerOpacities = state.layerOpacities ?? [1.0, 1.0, 1.0];
    const layerOpacities: [number, number, number] = [
      globalLayerOpacity * sourceLayerOpacities[0],
      globalLayerOpacity * sourceLayerOpacities[1],
      globalLayerOpacity * sourceLayerOpacities[2],
    ];
    const stampBoost = state.stampBoost ?? 1.8;

    // ── Passes 0-2: render each colour layer ──────────────────────────────
    for (let i = 0; i < 3; i++) {
      const lp    = this.layerPipelines[i];
      const layer = state.layers[i];

      const rad    = (layer.angleDeg * Math.PI) / 180;
      const flipX  = layer.flipX ? 1.0 : 0.0;
      const flipY  = layer.flipY ? 1.0 : 0.0;
      const aspect = canvasTex.width / canvasTex.height;
      lp.rotationData.set([rad, flipX, flipY, aspect]);
      this.device.queue.writeBuffer(lp.rotationBuffer, 0, lp.rotationData.buffer as ArrayBuffer, lp.rotationData.byteOffset, 16);

      const colorMode = state.colorMode ?? 1.0;
      const useMask = this.classificationMaskTexture && colorMode === 0 ? 1 : 0;
      const sobelEnabled = state.sobelEnabled ? 1 : 0;
      const softCropEnabled = state.softCropEnabled ? 1 : 0;
      lp.fragData.set([
        state.avgLuminance, layerOpacities[i], colorMode, useMask,
        sobelEnabled, softCropEnabled, 0, 0,
      ]);
      this.device.queue.writeBuffer(lp.fragUniformBuffer, 0, lp.fragData.buffer as ArrayBuffer, lp.fragData.byteOffset, 32);

      const bindGroup = this.getLayerBindGroup(i);

      const usesMSAA = this.sampleCount > 1 && this.msaaTexture !== null;
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view         : usesMSAA ? this.msaaTexture!.createView() : this.layerTextures[i].createView(),
          resolveTarget: usesMSAA ? this.layerTextures[i].createView() : undefined,
          loadOp       : 'clear',
          storeOp      : usesMSAA ? 'discard' : 'store',
          clearValue   : { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(lp.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
    }

    // ── Pass 3: persistence (Run twice: Once for Below, Once for Above) ─────────
    const colorThresh = state.tracerThreshold ?? 0.05;
    const tracerMode = state.tracerMode ?? 0.0;
    const readIdx  : 0 | 1 = this.persistPingPong;
    const writeIdx : 0 | 1 = readIdx === 0 ? 1 : 0;

    const peakMode = state.peakCollisionsOnly ? 1 : 0;

    // Helper to run a persistence pass
    const runPersistPass = (
      duration: number,
      uniformBuf: GPUBuffer,
      textures: [GPUTexture | null, GPUTexture | null]
    ) => {
      const decayFactor = durationToDecay(duration, fps);

      this.persistF32[0] = decayFactor;
      this.persistF32[1] = colorThresh;
      this.persistF32[2] = stampBoost;
      this.persistU32[3] = tracerMode;
      this.persistU32[4] = peakMode;
      this.device.queue.writeBuffer(uniformBuf, 0, this.persistUniformData);

      const bg = this.getPersistenceBindGroup(
        textures === this.persistBelowTextures ? this.persistBelowBindGroupCache : this.persistAboveBindGroupCache,
        readIdx,
        textures,
        uniformBuf,
      );

      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view      : textures[writeIdx]!.createView(),
            loadOp    : 'clear', storeOp   : 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
          {
            view      : this.persistDiagnosticTextures[writeIdx]!.createView(),
            loadOp    : 'clear', storeOp   : 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      pass.setPipeline(this.persistPipeline); pass.setBindGroup(0, bg); pass.draw(6); pass.end();
    };

    if (!state.paused) {
      runPersistPass(state.tracerBelowDuration ?? 0, this.persistBelowUniformBuf, this.persistBelowTextures);
      runPersistPass(state.tracerAboveDuration ?? 1000, this.persistAboveUniformBuf, this.persistAboveTextures);
      this.persistPingPong = writeIdx;
    }

    // ── Pass 4: compositor ───────────
    const tracerAboveOp = state.tracerAboveIntensity ?? 0.85;
    const tracerBelowOp = state.tracerBelowIntensity ?? 0.30;
    const layerBlendMode = state.layerBlendMode ?? 0;
    const tracerBlendMode = state.tracerBlendMode ?? 0;

    this.compositorF32[0] = tracerAboveOp;
    this.compositorF32[1] = tracerBelowOp;
    this.compositorU32[2] = layerBlendMode;
    this.compositorU32[3] = tracerBlendMode;
    this.compositorF32[4] = layerOpacities[0];
    this.compositorF32[5] = layerOpacities[1];
    this.compositorF32[6] = layerOpacities[2];
    this.compositorF32[7] = state.diagnosticsOpacity ?? 0.55;
    this.compositorF32[8] = stampBoost;
    this.compositorU32[9] = state.outputMode ?? 0;
    this.compositorU32[10] = tracerMode;
    this.compositorU32[11] = state.diagnosticsMode ? 1 : 0;
    this.compositorU32[12] = state.viewportQuarterZoom ? 1 : 0;

    this.device.queue.writeBuffer(this.compositorUniformBuf, 0, this.compositorUniformData);

    const compBG = this.getCompositorBindGroup();

    // ── Final output to main canvas ─────────────────────────────────────────
    // Two paths:
    //   • Normal: full 5-pass compositor (layers + dual tracers + blend modes)
    //   • Tracer View (new): direct high-quality aspect-fit blit of the live
    //     persistence buffer (Above) so user can inspect the accumulated
    //     trails/feedback at native internal resolution, centered, letterboxed
    //     if the current canvas shape doesn't match the tracer tex aspect.
    const mainViewMode = state.mainViewMode ?? (
      (state.showTracerView ?? false)
        ? MAIN_VIEW_MODES.FULL_RES_TRACER
        : MAIN_VIEW_MODES.PROCESSED_COMPOSITE
    );

    if (mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER) {
      this.encodeTracerViewPass(
        enc,
        canvasTex.createView(),
        canvasTex.width,
        canvasTex.height,
        tracerAboveOp,
        tracerBelowOp,
        tracerBlendMode,
        state.tracerInspectZoom ?? 1,
        state.tracerInspectPanX ?? 0,
        state.tracerInspectPanY ?? 0,
        state.tracerInspectHeatmap ?? false,
        state.tracerInspectExposure ?? 1.04,
        state.tracerInspectTonemap ?? true,
        state.tracerInspectShowLayers ?? false,
        layerBlendMode,
        layerOpacities[0],
        layerOpacities[1],
        layerOpacities[2],
      );
    } else if (mainViewMode === MAIN_VIEW_MODES.SOURCE_IMAGE) {
      this.displayF32[0] = canvasTex.width / Math.max(1, canvasTex.height);
      this.displayF32[1] = this.currentTexture.width / Math.max(1, this.currentTexture.height);
      this.displayU32[2] = 0;
      this.displayU32[3] = 0;
      this.device.queue.writeBuffer(this.displayUniformBuf, 0, this.displayUniformData);

      const displayBG = this.device.createBindGroup({
        layout: this.displayBGL,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: this.currentTexture.createView() },
          { binding: 2, resource: { buffer: this.displayUniformBuf } },
        ],
      });

      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: canvasTex.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(this.displayPipeline);
      pass.setBindGroup(0, displayBG);
      pass.draw(6);
      pass.end();
    } else if (mainViewMode >= MAIN_VIEW_MODES.LAYER_0 && mainViewMode <= MAIN_VIEW_MODES.LAYER_2) {
      const layerIndex = mainViewMode - MAIN_VIEW_MODES.LAYER_0;
      const layerTexture = this.layerTextures[layerIndex];
      this.displayF32[0] = 1.0;
      this.displayF32[1] = 1.0;
      this.displayU32[2] = 1;
      this.displayU32[3] = 0;
      this.device.queue.writeBuffer(this.displayUniformBuf, 0, this.displayUniformData);

      const displayBG = this.device.createBindGroup({
        layout: this.displayBGL,
        entries: [
          { binding: 0, resource: this.compositorSampler },
          { binding: 1, resource: layerTexture.createView() },
          { binding: 2, resource: { buffer: this.displayUniformBuf } },
        ],
      });

      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: canvasTex.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(this.displayPipeline);
      pass.setBindGroup(0, displayBG);
      pass.draw(6);
      pass.end();
    } else if (mainViewMode === MAIN_VIEW_MODES.COINCIDENCE_HEATMAP) {
      this.heatmapF32[0] = colorThresh;
      this.heatmapF32[1] = 0;
      this.heatmapF32[2] = 0;
      this.heatmapF32[3] = 0;
      this.device.queue.writeBuffer(this.heatmapUniformBuf, 0, this.heatmapUniformData);

      const heatmapBG = this.getHeatmapBindGroup();

      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: canvasTex.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(this.heatmapPipeline);
      pass.setBindGroup(0, heatmapBG);
      pass.draw(6);
      pass.end();
    } else if (mainViewMode === MAIN_VIEW_MODES.COMPARE_SOURCE_COMPOSITE) {
      this.compareF32[0] = this.currentTexture.width / Math.max(1, this.currentTexture.height);
      this.compareF32[1] = tracerAboveOp;
      this.compareF32[2] = tracerBelowOp;
      this.compareU32[3] = layerBlendMode;
      this.compareU32[4] = tracerBlendMode;
      this.compareF32[5] = layerOpacities[0];
      this.compareF32[6] = layerOpacities[1];
      this.compareF32[7] = layerOpacities[2];
      this.compareF32[8] = stampBoost;
      this.compareF32[9] = 0.004;
      this.compareU32[10] = state.outputMode ?? 0;
      this.compareU32[11] = tracerMode;
      this.device.queue.writeBuffer(this.compareUniformBuf, 0, this.compareUniformData);

      const compareBG = this.device.createBindGroup({
        layout: this.compareBGL,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: this.currentTexture.createView() },
          { binding: 2, resource: this.layerTextures[0].createView() },
          { binding: 3, resource: this.layerTextures[1].createView() },
          { binding: 4, resource: this.layerTextures[2].createView() },
          { binding: 5, resource: this.persistBelowTextures[this.persistPingPong]!.createView() },
          { binding: 6, resource: this.persistAboveTextures[this.persistPingPong]!.createView() },
          { binding: 7, resource: { buffer: this.compareUniformBuf } },
        ],
      });

      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: canvasTex.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      pass.setPipeline(this.comparePipeline);
      pass.setBindGroup(0, compareBG);
      pass.draw(6);
      pass.end();
    } else if (mainViewMode === MAIN_VIEW_MODES.STAMP_DIAGNOSTICS) {
      const persistDiagTex = this.persistDiagnosticTextures[this.persistPingPong];
      if (persistDiagTex) {
        const stampDiagBG = this.device.createBindGroup({
          layout: this.stampDiagnosticViewBGL,
          entries: [
            { binding: 0, resource: this.stampDiagnosticViewSampler },
            { binding: 1, resource: persistDiagTex.createView() },
          ],
        });
        const pass = enc.beginRenderPass({
          colorAttachments: [{
            view: canvasTex.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          }],
        });
        pass.setPipeline(this.stampDiagnosticViewPipeline);
        pass.setBindGroup(0, stampDiagBG);
        pass.draw(6);
        pass.end();
      }
    } else {
      const finalPass = enc.beginRenderPass({
        colorAttachments: [{
          view      : canvasTex.createView(),
          loadOp    : 'clear',
          storeOp   : 'store',
          // Opaque clear. alphaMode:'opaque' on the swapchain should already
          // force this, but some browser+GPU combos don't honour it and let
          // the compositor see straight through to whatever's behind the browser
          // window when rendered alpha is 0.
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      finalPass.setPipeline(this.compositorPipeline);
      finalPass.setBindGroup(0, compBG);
      finalPass.draw(6);
      finalPass.end();
    }

    // ── Preview pass: compositor → small thumbnail texture + copy to staging ──
    // This is opt-in. When no thumbnail refresh was requested, render() skips
    // the extra compositor pass and GPU readback entirely.
    let shouldStartPreviewReadback = false;
    let shouldStartDiagnosticReadback = false;
    if (this.previewCaptureQueued && !this.previewReadPending) {
      this.ensurePreviewResources();
    }
    if (this.diagnosticCaptureQueued && !this.diagnosticReadPending) {
      this.ensureDiagnosticResources();
    }
    if (this.previewCaptureQueued && this.previewTexture && this.previewStagingBuffer && this.previewReadCallback) {
      const sz = WebGPURenderer.PREVIEW_SIZE;

      // Thumbnail preview always shows the full compositor frame, not the zoomed viewport.
      if (state.viewportQuarterZoom) {
        this.compositorU32[12] = 0;
        this.device.queue.writeBuffer(this.compositorUniformBuf, 0, this.compositorUniformData);
      }

      // Render the same compositor output into the small preview texture.
      // The compositor bind group (compBG) and pipeline are resolution-agnostic,
      // so they work correctly at any output size.
      const previewPass = enc.beginRenderPass({
        colorAttachments: [{
          view      : this.previewTexture.createView(),
          loadOp    : 'clear',
          storeOp   : 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      previewPass.setPipeline(this.compositorPipeline);
      previewPass.setBindGroup(0, compBG);
      previewPass.draw(6);
      previewPass.end();

      // Copy the tiny result into the reusable staging buffer for CPU readback.
      // bytesPerRow = PREVIEW_SIZE * 4, aligned by construction.
      enc.copyTextureToBuffer(
        { texture: this.previewTexture },
        { buffer: this.previewStagingBuffer, bytesPerRow: sz * 4 },
        [sz, sz, 1]
      );
      this.previewCaptureQueued = false;
      shouldStartPreviewReadback = true;
    }

    if (this.diagnosticCaptureQueued && this.diagnosticTexture && this.diagnosticStagingBuffer && this.diagnosticReadCallback) {
      const sz = WebGPURenderer.DIAGNOSTIC_SIZE;

      // Blit from the persist diagnostic texture (actual stamp data) into the
      // 64×64 readback texture, replacing the old live-layer approximation.
      const persistDiagTex = this.persistDiagnosticTextures[writeIdx];
      if (persistDiagTex) {
        const blitBG = this.device.createBindGroup({
          layout: this.persistDiagnosticBlitBGL,
          entries: [
            { binding: 0, resource: this.persistDiagnosticSampler },
            { binding: 1, resource: persistDiagTex.createView() },
          ],
        });
        const blitPass = enc.beginRenderPass({
          colorAttachments: [{
            view: this.diagnosticTexture.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          }],
        });
        blitPass.setPipeline(this.persistDiagnosticBlitPipeline);
        blitPass.setBindGroup(0, blitBG);
        blitPass.draw(6);
        blitPass.end();
      }

      enc.copyTextureToBuffer(
        { texture: this.diagnosticTexture },
        { buffer: this.diagnosticStagingBuffer, bytesPerRow: sz * 4 },
        [sz, sz, 1],
      );
      this.diagnosticCaptureQueued = false;
      shouldStartDiagnosticReadback = true;
    }

    this.device.queue.submit([enc.finish()]);
    this.lastRenderCpuMs = performance.now() - renderStart;
    this.averageRenderCpuMs = this.averageRenderCpuMs === 0
      ? this.lastRenderCpuMs
      : this.averageRenderCpuMs * 0.9 + this.lastRenderCpuMs * 0.1;
    if (shouldStartPreviewReadback) this.beginPreviewReadback();
    if (shouldStartDiagnosticReadback) this.beginDiagnosticReadback();
  }

  async exportTracerView(options: {
    width?: number;
    height?: number;
    tracerAboveOpacity?: number;
    tracerBelowOpacity?: number;
    tracerBlendMode?: number;
    inspectZoom?: number;
    inspectPanX?: number;
    inspectPanY?: number;
    showHeatmap?: boolean;
    exposure?: number;
    applyTonemap?: boolean;
    showLayers?: boolean;
    layerBlendMode?: number;
    layerOpacity0?: number;
    layerOpacity1?: number;
    layerOpacity2?: number;
  }): Promise<{ width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } | null> {
    const pTexAbove = this.persistAboveTextures[this.persistPingPong];
    if (!pTexAbove) return null;

    const width = Math.max(1, Math.floor(options.width ?? pTexAbove.width));
    const height = Math.max(1, Math.floor(options.height ?? pTexAbove.height));
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
    this.encodeTracerViewPass(
      enc,
      output.createView(),
      width,
      height,
      options.tracerAboveOpacity ?? 0.85,
      options.tracerBelowOpacity ?? 0.30,
      options.tracerBlendMode ?? 0,
      options.inspectZoom ?? 1,
      options.inspectPanX ?? 0,
      options.inspectPanY ?? 0,
      options.showHeatmap ?? false,
      options.exposure ?? 1.04,
      options.applyTonemap ?? true,
      options.showLayers ?? false,
      options.layerBlendMode ?? 0,
      options.layerOpacity0 ?? 1,
      options.layerOpacity1 ?? 1,
      options.layerOpacity2 ?? 1,
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
    for (const lp of this.layerPipelines) {
      lp.rotationBuffer.destroy();
      lp.fragUniformBuffer.destroy();
    }
    for (const t of this.layerTextures) t.destroy();
    this.msaaTexture?.destroy();
    this.persistAboveTextures[0]?.destroy();
    this.persistAboveTextures[1]?.destroy();
    this.persistBelowTextures[0]?.destroy();
    this.persistBelowTextures[1]?.destroy();
    this.persistDiagnosticTextures[0]?.destroy();
    this.persistDiagnosticTextures[1]?.destroy();
    this.persistAboveUniformBuf.destroy();
    this.persistBelowUniformBuf.destroy();
    this.compositorUniformBuf.destroy();
    this.tracerViewUniformBuf.destroy();
    this.displayUniformBuf.destroy();
    this.heatmapUniformBuf.destroy();
    this.compareUniformBuf.destroy();
    this.fallbackMaskTexture.destroy();
    this.previewTexture?.destroy();
    this.previewStagingBuffer?.destroy();
    this.diagnosticTexture?.destroy();
    this.diagnosticStagingBuffer?.destroy();
  }
}
