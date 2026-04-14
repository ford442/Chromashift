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
  tracerAboveIntensity?: number;  // NEW
  tracerBelowIntensity?: number;  // NEW
  tracerAboveDuration? : number;  // NEW
  tracerBelowDuration? : number;  // NEW
  tracerThreshold?     : number;
  tracerMode?          : number;  // 0 = combined colors, 1 = grey highlight
  layerBlendMode?      : number;  // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen
  tracerBlendMode?     : number;  // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen
}

/** Column-major mat3x3 for WGSL std140. */
function buildRotationMat3(angleDeg: number): Float32Array {
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0]);
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
  return Math.pow(1 / 255, 1 / frames);
}

interface LayerPipeline {
  pipeline          : GPURenderPipeline;
  bindGroupLayout   : GPUBindGroupLayout;
  rotationBuffer    : GPUBuffer;
  fragUniformBuffer : GPUBuffer;
}

export class WebGPURenderer {
  private device      : GPUDevice;
  private context     : GPUCanvasContext;
  private format      : GPUTextureFormat;
  private sampler     : GPUSampler;
  private sampleCount : number = 4;

  // Layer passes
  private layerPipelines : LayerPipeline[] = [];
  private currentTexture : GPUTexture | null = null;

  // Intermediate per-layer render textures (always 1x — resolved from MSAA)
  private layerTextures : GPUTexture[] = [];
  private msaaTexture   : GPUTexture | null = null;
  private texW = 0;
  private texH = 0;

  // Persistence ping-pong (Dual system)
  private persistAboveTextures  : [GPUTexture | null, GPUTexture | null] = [null, null];
  private persistBelowTextures  : [GPUTexture | null, GPUTexture | null] = [null, null];
  private persistPingPong       : 0 | 1 = 0;  // shared index
  private persistPipeline       : GPURenderPipeline;
  private persistBGL            : GPUBindGroupLayout;
  private persistAboveUniformBuf: GPUBuffer;
  private persistBelowUniformBuf: GPUBuffer;

  // Compositor
  private compositorPipeline  : GPURenderPipeline;
  private compositorBGL       : GPUBindGroupLayout;
  private compositorSampler   : GPUSampler;
  private compositorUniformBuf: GPUBuffer;

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, enableMSAA = true) {
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
      size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const fragUniformBuffer = device.createBuffer({
      size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    return { pipeline, bindGroupLayout, rotationBuffer, fragUniformBuffer };
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
        targets    : [{
          format: this.format,
          blend : {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
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

    // Layer intermediate textures (always 1x so compositor can sample them)
    this.layerTextures = [0, 1, 2].map(() => this.device.createTexture({
      size       : [w, h, 1],
      format     : this.format,
      usage      : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      sampleCount: 1,
    }));

    // MSAA resolve target (only needed when AA is on)
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

    // Persistence ping-pong textures — both start as RENDER_ATTACHMENT + TEXTURE_BINDING + COPY_SRC
    const createPersistTex = () => this.device.createTexture({
      size  : [w, h, 1], format: this.format,
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
  }

  /**
   * Get the current persistence texture (the accumulated layer overlaps).
   * Returns null if textures haven't been initialized yet.
   */
  getPersistenceTexture(): GPUTexture | null {
    return this.persistAboveTextures[this.persistPingPong];
  }

  render(state: RendererState, fps = 30): void {
    if (!this.currentTexture) return;

    const canvasTex = this.context.getCurrentTexture();
    this.ensureTextures(canvasTex.width, canvasTex.height);

    const enc = this.device.createCommandEncoder();

    // ── Passes 0-2: render each colour layer ──────────────────────────────
    for (let i = 0; i < 3; i++) {
      const lp    = this.layerPipelines[i];
      const layer = state.layers[i];

      const rotMat = buildRotationMat3(layer.angleDeg);
      const flipX  = layer.flipX ? 1 : 0;
      const flipY  = layer.flipY ? 1 : 0;
      const rotBuf = new ArrayBuffer(64);
      new Float32Array(rotBuf).set(rotMat);
      new Uint32Array(rotBuf, 48).set([flipX, flipY]);
      this.device.queue.writeBuffer(lp.rotationBuffer, 0, rotBuf);

      const opacity = state.layerOpacity ?? 1.0;
      this.device.queue.writeBuffer(lp.fragUniformBuffer, 0,
        new Float32Array([state.avgLuminance, opacity, 0, 0]));

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
      this.device.queue.writeBuffer(uniformBuf, 0, new Float32Array([decayFactor, colorThresh, tracerMode, 0]));

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

    // Execute Below Pass
    runPersistPass(state.tracerBelowDuration ?? 0, this.persistBelowUniformBuf, this.persistBelowTextures);
    // Execute Above Pass
    runPersistPass(state.tracerAboveDuration ?? 1000, this.persistAboveUniformBuf, this.persistAboveTextures);

    this.persistPingPong = writeIdx;

    // ── Pass 4: compositor ───────────
    const tracerAboveOp = state.tracerAboveIntensity ?? 0.85;
    const tracerBelowOp = state.tracerBelowIntensity ?? 0.0;
    const layerBlendMode = state.layerBlendMode ?? 0;
    const tracerBlendMode = state.tracerBlendMode ?? 0;
    const layerOpacity = state.layerOpacity ?? 1.0;

    const compositorUniforms = new ArrayBuffer(32);
    const floatView = new Float32Array(compositorUniforms);
    const uintView = new Uint32Array(compositorUniforms);
    floatView[0] = tracerAboveOp;
    floatView[1] = tracerBelowOp;
    uintView[2] = layerBlendMode;
    uintView[3] = tracerBlendMode;
    floatView[4] = layerOpacity;
    floatView[5] = layerOpacity;
    floatView[6] = layerOpacity;

    this.device.queue.writeBuffer(this.compositorUniformBuf, 0, compositorUniforms);

    const compBG = this.device.createBindGroup({
      layout : this.compositorBGL,
      entries: [
        { binding: 0, resource: this.compositorSampler },
        { binding: 1, resource: this.layerTextures[0].createView() },
        { binding: 2, resource: this.layerTextures[1].createView() },
        { binding: 3, resource: this.layerTextures[2].createView() },
        { binding: 4, resource: this.persistBelowTextures[writeIdx]!.createView() }, // Binding 4: Below
        { binding: 5, resource: this.persistAboveTextures[writeIdx]!.createView() }, // Binding 5: Above
        { binding: 6, resource: { buffer: this.compositorUniformBuf } },
      ],
    });

    const finalPass = enc.beginRenderPass({
      colorAttachments: [{
        view      : canvasTex.createView(),
        loadOp    : 'clear',
        storeOp   : 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    finalPass.setPipeline(this.compositorPipeline);
    finalPass.setBindGroup(0, compBG);
    finalPass.draw(6);
    finalPass.end();

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
  }
}
