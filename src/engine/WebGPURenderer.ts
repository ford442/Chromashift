/**
 * WebGPURenderer
 *
 * 5-pass rendering pipeline:
 *   Pass 0–2 : Each colour layer → its own intermediate GPUTexture
 *   Pass 3   : Persistence pass — detects 2+ layer overlap, writes mixed
 *              colour into ping-pong buffer, decays previous hits
 *   Pass 4   : Compositor — live layers + persistence overlay → canvas
 */

import {
  vertexShaderSource,
  fragmentShaderRedOrange,
  fragmentShaderVioletBlue,
  fragmentShaderGreenYellow,
  fullscreenVertexSource,
  persistenceFragmentSource,
  compositorFragmentSource,
} from './shaders';

export interface LayerState {
  angleDeg : number;
  flipX?   : boolean;
  flipY?   : boolean;
}

export interface RendererState {
  layers               : [LayerState, LayerState, LayerState];
  avgLuminance         : number;
  layerOpacity?        : number;
  layerScale?          : number;  // 0.1–2.0, default 1.0
  tracerScale?         : number;  // 0.1–2.0, default 1.0
  tracerAboveIntensity?: number;  // NEW
  tracerBelowIntensity?: number;  // NEW
  tracerAboveDuration? : number;  // NEW
  tracerBelowDuration? : number;  // NEW
  tracerThreshold?     : number;
  tracerMode?          : number;  // 0 = combined colors, 1 = grey highlight
  layerBlendMode?      : number;  // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen, 5=lighten, 6=darken, 7=overlay, 8=color dodge, 9=color burn, 10=difference, 11=exclusion, 12=hard light
  tracerBlendMode?     : number;  // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen, 5=lighten, 6=darken, 7=overlay, 8=color dodge, 9=color burn, 10=difference, 11=exclusion, 12=hard light
  outputMode?          : number;  // 0 = mixed, 1 = tracer focus, 2 = tracer only
  paused?              : boolean; // When true, tracer persistence stops decaying
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

interface LayerPipeline {
  pipeline          : GPURenderPipeline;
  bindGroupLayout   : GPUBindGroupLayout;
  rotationBuffer    : GPUBuffer;
  fragUniformBuffer : GPUBuffer;
  rotationData      : Float32Array;
  fragData          : Float32Array;
}

export class WebGPURenderer {
  /** Size of the composited preview texture (fixed, independent of canvas/tracerScale). */
  static readonly PREVIEW_SIZE = 256;

  private device      : GPUDevice;
  private context     : GPUCanvasContext;
  private format      : GPUTextureFormat;
  private sampler     : GPUSampler;
  private sampleCount : number = 4;

  // Layer passes
  private layerPipelines : LayerPipeline[] = [];
  private currentTexture : GPUTexture | null = null;

  // Intermediate per-layer render textures (scaled by layerScale)
  private layerTextures : GPUTexture[] = [];
  private msaaTexture   : GPUTexture | null = null;
  private texW = 0;
  private texH = 0;
  private layerScale = 1.0;
  private tracerScale = 1.0;

  // Persistence ping-pong (Dual system)
  private persistAboveTextures  : [GPUTexture | null, GPUTexture | null] = [null, null];
  private persistBelowTextures  : [GPUTexture | null, GPUTexture | null] = [null, null];
  private persistPingPong       : 0 | 1 = 0;  // shared index
  private persistPipeline       : GPURenderPipeline;
  private persistBGL            : GPUBindGroupLayout;
  private persistAboveUniformBuf: GPUBuffer;
  private persistBelowUniformBuf: GPUBuffer;
  private persistUniformData = new ArrayBuffer(16);
  private persistF32 = new Float32Array(this.persistUniformData);
  private persistU32 = new Uint32Array(this.persistUniformData);

  // Compositor
  private compositorPipeline  : GPURenderPipeline;
  private compositorBGL       : GPUBindGroupLayout;
  private compositorSampler   : GPUSampler;
  private compositorUniformBuf: GPUBuffer;

  // Small composited preview — fixed 256×256, independent of canvas/tracerScale
  private previewTexture      : GPUTexture | null = null;
  private previewStagingBuffer: GPUBuffer | null = null;
  private previewReadPending  = false;

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, enableMSAA = false) {
    this.device  = device;
    this.context = context;
    this.format  = format;
    this.sampleCount = enableMSAA ? 4 : 1;

    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    });

    const fragSources = [fragmentShaderRedOrange, fragmentShaderVioletBlue, fragmentShaderGreenYellow];
    for (const src of fragSources) this.layerPipelines.push(this.createLayerPipeline(src));

    this.compositorSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    // Persistence pipeline
    this.persistBGL      = this.createPersistBGL();
    this.persistPipeline = this.createPersistPipeline();
    this.persistAboveUniformBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.persistBelowUniformBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // Compositor pipeline
    this.compositorBGL      = this.createCompositorBGL();
    this.compositorPipeline = this.createCompositorPipeline();
    this.compositorUniformBuf = device.createBuffer({
      size: 32, // Accommodates the new struct layout
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private compositorUniformData = new ArrayBuffer(32);
  private compositorF32 = new Float32Array(this.compositorUniformData);
  private compositorU32 = new Uint32Array(this.compositorUniformData);

  // ─── Layer pipeline ─────────────────────────────────────────────────────────
  private createLayerPipeline(fragmentSource: string): LayerPipeline {
    const device = this.device;

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX,   buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    const pipeline = device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex  : { module: device.createShaderModule({ code: vertexShaderSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: fragmentSource }),
        entryPoint : 'main',
        targets    : [{ format: this.format }],
      },
      primitive  : { topology: 'triangle-list' },
      multisample: { count: this.sampleCount },
    });

    const rotationBuffer = device.createBuffer({
      size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const fragUniformBuffer = device.createBuffer({
      size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    return { pipeline, bindGroupLayout, rotationBuffer, fragUniformBuffer, rotationData: new Float32Array(4), fragData: new Float32Array(4) };
  }

  // ─── Persistence pipeline ────────────────────────────────────────────────────
  private createPersistBGL(): GPUBindGroupLayout {
    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
  }

  private createPersistPipeline(): GPURenderPipeline {
    const device = this.device;
    return device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [this.persistBGL] }),
      vertex  : { module: device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: persistenceFragmentSource }),
        entryPoint : 'main',
        targets    : [{ format: this.format }],
      },
      primitive  : { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  // ─── Compositor pipeline ─────────────────────────────────────────────────────
  private createCompositorBGL(): GPUBindGroupLayout {
    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, // NEW: persistAbove
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },      // MOVED to 6
      ],
    });
  }

  private createCompositorPipeline(): GPURenderPipeline {
    const device = this.device;
    return device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [this.compositorBGL] }),
      vertex  : { module: device.createShaderModule({ code: fullscreenVertexSource }), entryPoint: 'main' },
      fragment: {
        module     : device.createShaderModule({ code: compositorFragmentSource }),
        entryPoint : 'main',
        targets    : [{ format: this.format }],
      },
      primitive  : { topology: 'triangle-list' },
      multisample: { count: 1 },
    });
  }

  // ─── Texture management ──────────────────────────────────────────────────────
  private ensureTextures(w: number, h: number): void {
    if (this.texW === w && this.texH === h && this.layerTextures.length === 3) return;

    // Destroy old textures
    for (const t of this.layerTextures) t.destroy();
    this.msaaTexture?.destroy();
    this.persistAboveTextures[0]?.destroy(); this.persistAboveTextures[1]?.destroy();
    this.persistBelowTextures[0]?.destroy(); this.persistBelowTextures[1]?.destroy();

    const layerW = Math.max(1, Math.round(w * this.layerScale));
    const layerH = Math.max(1, Math.round(h * this.layerScale));
    const tracerW = Math.max(1, Math.round(w * this.tracerScale));
    const tracerH = Math.max(1, Math.round(h * this.tracerScale));

    // Layer intermediate textures (scaled by layerScale)
    this.layerTextures = [0, 1, 2].map(() => this.device.createTexture({
      size       : [layerW, layerH, 1],
      format     : this.format,
      usage      : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      sampleCount: 1,
    }));

    // MSAA resolve target (always at full canvas resolution)
    if (this.sampleCount > 1) {
      this.msaaTexture = this.device.createTexture({
        size       : [w, h, 1],
        format     : this.format,
        sampleCount: this.sampleCount,
        usage      : GPUTextureUsage.RENDER_ATTACHMENT,
      });
    } else {
      this.msaaTexture = null;
    }

    // Persistence ping-pong textures — scaled by tracerScale
    const createPersistTex = () => this.device.createTexture({
      size  : [tracerW, tracerH, 1], format: this.format,
      usage : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    this.persistAboveTextures = [createPersistTex(), createPersistTex()] as [GPUTexture, GPUTexture];
    this.persistBelowTextures = [createPersistTex(), createPersistTex()] as [GPUTexture, GPUTexture];

    this.persistPingPong = 0;
    this.texW = w;
    this.texH = h;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────
  setTexture(texture: GPUTexture): void {
    this.currentTexture = texture;
  }

  setAntialiasing(enabled: boolean): void {
    const next = enabled ? 4 : 1;
    if (next === this.sampleCount) return;
    this.sampleCount = next;

    // Rebuild layer pipelines with new sample count
    this.layerPipelines = [];
    for (const src of [fragmentShaderRedOrange, fragmentShaderVioletBlue, fragmentShaderGreenYellow]) {
      this.layerPipelines.push(this.createLayerPipeline(src));
    }

    // Force texture recreation
    for (const t of this.layerTextures) t.destroy();
    this.layerTextures = [];
    this.msaaTexture?.destroy();
    this.msaaTexture = null;
    this.persistAboveTextures[0]?.destroy(); this.persistAboveTextures[1]?.destroy();
    this.persistBelowTextures[0]?.destroy(); this.persistBelowTextures[1]?.destroy();
    this.persistAboveTextures = [null, null];
    this.persistBelowTextures = [null, null];
    this.texW = 0;
    this.texH = 0;
    this.layerScale = 1.0;
    this.tracerScale = 1.0;
  }

  /**
   * Get the current persistence texture (the accumulated layer overlaps).
   * Returns null if textures haven't been initialized yet.
   * @deprecated Use readPreviewPixels() for the preview, which shows the composited output.
   */
  getPersistenceTexture(): GPUTexture | null {
    return this.persistAboveTextures[this.persistPingPong];
  }

  // ─── Preview resources ────────────────────────────────────────────────────
  /**
   * Create the fixed-size composited preview texture and its reusable staging
   * buffer.  Called lazily from render() the first time.
   *
   * PREVIEW_SIZE = 256 → bytesPerRow = 256×4 = 1024, which is already aligned
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

    // bytesPerRow = 256 * 4 = 1024 (multiple of 256 ✓, no padding needed)
    this.previewStagingBuffer = this.device.createBuffer({
      size : sz * sz * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  /**
   * Initiate an async read-back of the composited preview texture.
   *
   * The callback receives a copy of the pixel data (RGBA8, 256×256) once the
   * GPU has finished and the buffer has been mapped.  Calls that arrive while
   * a previous read is still in-flight are ignored (the preview updates at
   * ~5 fps so this never causes visible stutter).
   */
  readPreviewPixels(callback: (data: Uint8ClampedArray<ArrayBuffer>) => void): void {
    if (!this.previewStagingBuffer || this.previewReadPending) return;
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
    });
  }

  /**
   * Clear all persistence textures to transparent black.
   * Call this when changing images to reset the tracer.
   */
  clearPersistence(): void {
    const enc = this.device.createCommandEncoder();
    
    // Clear all 4 persistence textures
    const allTextures = [
      this.persistAboveTextures[0], this.persistAboveTextures[1],
      this.persistBelowTextures[0], this.persistBelowTextures[1]
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

  render(state: RendererState, fps = 30): void {
    if (!this.currentTexture) return;

    this.layerScale = state.layerScale ?? 1.0;
    this.tracerScale = state.tracerScale ?? 1.0;

    const canvasTex = this.context.getCurrentTexture();
    this.ensureTextures(canvasTex.width, canvasTex.height);

    const enc = this.device.createCommandEncoder();

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

      const opacity = state.layerOpacity ?? 1.0;
      lp.fragData.set([state.avgLuminance, opacity, 0, 0]);
      this.device.queue.writeBuffer(lp.fragUniformBuffer, 0, lp.fragData.buffer as ArrayBuffer, lp.fragData.byteOffset, 16);

      const bindGroup = this.device.createBindGroup({
        layout : lp.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: lp.rotationBuffer } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.currentTexture.createView() },
          { binding: 3, resource: { buffer: lp.fragUniformBuffer } },
        ],
      });

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

    // Helper to run a persistence pass
    const runPersistPass = (
      duration: number,
      uniformBuf: GPUBuffer,
      textures: [GPUTexture | null, GPUTexture | null]
    ) => {
      const decayFactor = durationToDecay(duration, fps);

      this.persistF32[0] = decayFactor;
      this.persistF32[1] = colorThresh;
      this.persistU32[2] = tracerMode;
      this.persistU32[3] = 0;
      this.device.queue.writeBuffer(uniformBuf, 0, this.persistUniformData);

      const bg = this.device.createBindGroup({
        layout : this.persistBGL,
        entries: [
          { binding: 0, resource: this.compositorSampler },
          { binding: 1, resource: this.layerTextures[0].createView() },
          { binding: 2, resource: this.layerTextures[1].createView() },
          { binding: 3, resource: this.layerTextures[2].createView() },
          { binding: 4, resource: textures[readIdx]!.createView() },
          { binding: 5, resource: { buffer: uniformBuf } },
        ],
      });

      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view      : textures[writeIdx]!.createView(),
          loadOp    : 'clear', storeOp   : 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
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
    const layerOpacity = state.layerOpacity ?? 1.0;

    this.compositorF32[0] = tracerAboveOp;
    this.compositorF32[1] = tracerBelowOp;
    this.compositorU32[2] = layerBlendMode;
    this.compositorU32[3] = tracerBlendMode;
    this.compositorF32[4] = layerOpacity;
    this.compositorF32[5] = layerOpacity;
    this.compositorF32[6] = layerOpacity;
    this.compositorU32[7] = state.outputMode ?? 0;

    this.device.queue.writeBuffer(this.compositorUniformBuf, 0, this.compositorUniformData);

    const compBG = this.device.createBindGroup({
      layout : this.compositorBGL,
      entries: [
        { binding: 0, resource: this.compositorSampler },
        { binding: 1, resource: this.layerTextures[0].createView() },
        { binding: 2, resource: this.layerTextures[1].createView() },
        { binding: 3, resource: this.layerTextures[2].createView() },
        { binding: 4, resource: this.persistBelowTextures[this.persistPingPong]!.createView() }, // Binding 4: Below
        { binding: 5, resource: this.persistAboveTextures[this.persistPingPong]!.createView() }, // Binding 5: Above
        { binding: 6, resource: { buffer: this.compositorUniformBuf } },
      ],
    });

    const finalPass = enc.beginRenderPass({
      colorAttachments: [{
        view      : canvasTex.createView(),
        loadOp    : 'clear',
        storeOp   : 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },  // Transparent background, not opaque black
      }],
    });
    finalPass.setPipeline(this.compositorPipeline);
    finalPass.setBindGroup(0, compBG);
    finalPass.draw(6);
    finalPass.end();

    // ── Preview pass: compositor → small 256×256 texture + copy to staging ──
    // Only runs when no readback is in-flight (can't write to a mapped buffer).
    this.ensurePreviewResources();
    if (this.previewTexture && this.previewStagingBuffer && !this.previewReadPending) {
      const sz = WebGPURenderer.PREVIEW_SIZE;

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
      // bytesPerRow = 256 * 4 = 1024 (256-byte aligned ✓).
      enc.copyTextureToBuffer(
        { texture: this.previewTexture },
        { buffer: this.previewStagingBuffer, bytesPerRow: sz * 4 },
        [sz, sz, 1]
      );
    }

    this.device.queue.submit([enc.finish()]);
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
    this.persistAboveUniformBuf.destroy();
    this.persistBelowUniformBuf.destroy();
    this.compositorUniformBuf.destroy();
    this.previewTexture?.destroy();
    this.previewStagingBuffer?.destroy();
  }
}
