/**
 * WebGPURenderer
 *
 * 4-pass rendering pipeline:
 *   Pass 0–2 : Each colour layer renders to its own intermediate GPUTexture
 *              (no blending – clean alpha for stacking detection)
 *   Pass 3   : Compositor reads all 3 layer textures, blends them, and
 *              applies a tracer/ghost highlight wherever all 3 have colour.
 */

import {
  vertexShaderSource,
  fragmentShaderRedOrange,
  fragmentShaderVioletBlue,
  fragmentShaderGreenYellow,
  compositorVertexSource,
  compositorFragmentSource,
} from './shaders';

export interface LayerState {
  angleDeg : number;
  flipX?   : boolean;
  flipY?   : boolean;
}

export interface RendererState {
  layers          : [LayerState, LayerState, LayerState];
  avgLuminance    : number;
  layerOpacity?   : number;
  tracerIntensity?: number;   // 0–1, how bright the ghost glow is (default 0.7)
  tracerThreshold?: number;   // min alpha to count as "has colour"  (default 0.05)
}

/** Build a column-major mat3x3 rotation for WGSL std140 layout. */
function buildRotationMat3(angleDeg: number): Float32Array {
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0]);
}

interface LayerPipeline {
  pipeline         : GPURenderPipeline;
  bindGroupLayout  : GPUBindGroupLayout;
  rotationBuffer   : GPUBuffer;
  fragUniformBuffer: GPUBuffer;
}

export class WebGPURenderer {
  private device  : GPUDevice;
  private context : GPUCanvasContext;
  private format  : GPUTextureFormat;
  private sampler : GPUSampler;
  private sampleCount: number = 1;  // MSAA sample count (1 = no AA, 4 = 4x MSAA)

  private layerPipelines: LayerPipeline[] = [];
  private currentTexture: GPUTexture | null = null;

  // Intermediate per-layer render textures
  private layerTextures: GPUTexture[] = [];
  private texW = 0;
  private texH = 0;
  private msaaTexture: GPUTexture | null = null;

  // Compositor pass
  private compositorPipeline    : GPURenderPipeline;
  private compositorBGL         : GPUBindGroupLayout;
  private compositorSampler     : GPUSampler;
  private compositorUniformBuf  : GPUBuffer;

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

    // Compositor sampler + pipeline
    this.compositorSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.compositorBGL     = this.createCompositorBGL();
    this.compositorPipeline = this.createCompositorPipeline();

    this.compositorUniformBuf = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  // ─── Layer pipeline factory ─────────────────────────────────────────────────
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
        targets    : [{ format: this.format }],   // no blending — write clean alpha
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: this.sampleCount },
    });

    // Rotation uniform: mat3x3 (48 b) + flipX/Y u32 (8 b) + padding = 64 b
    const rotationBuffer = device.createBuffer({
      size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Fragment uniform: avgLuminance + layerOpacity + 2× pad = 16 b
    const fragUniformBuffer = device.createBuffer({
      size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    return { pipeline, bindGroupLayout, rotationBuffer, fragUniformBuffer };
  }

  // ─── Compositor pipeline factory ────────────────────────────────────────────
  private createCompositorBGL(): GPUBindGroupLayout {
    return this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
  }

  private createCompositorPipeline(): GPURenderPipeline {
    const device = this.device;
    return device.createRenderPipeline({
      layout  : device.createPipelineLayout({ bindGroupLayouts: [this.compositorBGL] }),
      vertex  : { module: device.createShaderModule({ code: compositorVertexSource }),   entryPoint: 'main' },
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
      primitive: { topology: 'triangle-list' },
      multisample: { count: 1 },  // Canvas always renders at 1x, MSAA only for layer passes
    });
  }

  // ─── Ensure intermediate textures match canvas size and sample count ─────────
  private ensureLayerTextures(w: number, h: number): void {
    if (this.texW === w && this.texH === h && this.layerTextures.length === 3) return;

    for (const t of this.layerTextures) t.destroy();
    if (this.msaaTexture) this.msaaTexture.destroy();

    this.layerTextures = [0, 1, 2].map(() => this.device.createTexture({
      size : [w, h, 1],
      format: this.format,
      usage : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      sampleCount: 1, // Intermediate resolved textures should always be 1x
    }));

    if (this.sampleCount > 1) {
      this.msaaTexture = this.device.createTexture({
        size: [w, h, 1],
        format: this.format,
        sampleCount: this.sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    } else {
      this.msaaTexture = null;
    }

    this.texW = w;
    this.texH = h;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  setTexture(texture: GPUTexture): void { this.currentTexture = texture; }

  setAntialiasing(enabled: boolean): void {
    const newSampleCount = enabled ? 4 : 1;
    if (newSampleCount === this.sampleCount) return;
    this.sampleCount = newSampleCount;

    // Force recreation of layer and MSAA textures on next render
    this.texW = 0;

    // Recreate pipelines with new sample count
    this.layerPipelines = [];
    const fragSources = [fragmentShaderRedOrange, fragmentShaderVioletBlue, fragmentShaderGreenYellow];
    for (const src of fragSources) this.layerPipelines.push(this.createLayerPipeline(src));
    this.compositorPipeline = this.createCompositorPipeline();
    // Force recreation of intermediate textures with new sample count
    for (const t of this.layerTextures) t.destroy();
    this.layerTextures = [];
    this.texW = 0;
    this.texH = 0;
  }

  render(state: RendererState): void {
    if (!this.currentTexture) return;

    const canvasTex = this.context.getCurrentTexture();
    this.ensureLayerTextures(canvasTex.width, canvasTex.height);

    const enc = this.device.createCommandEncoder();

    // ── Passes 0-2: render each layer to its own intermediate texture ──────
    for (let i = 0; i < 3; i++) {
      const lp    = this.layerPipelines[i];
      const layer = state.layers[i];

      // Upload rotation + flip
      const rotMat = buildRotationMat3(layer.angleDeg);
      const flipX  = layer.flipX ? 1 : 0;
      const flipY  = layer.flipY ? 1 : 0;
      const rotBuf = new ArrayBuffer(64);
      new Float32Array(rotBuf).set(rotMat);
      new Uint32Array(rotBuf, 48).set([flipX, flipY]);
      this.device.queue.writeBuffer(lp.rotationBuffer, 0, rotBuf);

      // Upload fragment uniforms
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

      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view      : this.sampleCount > 1 && this.msaaTexture ? this.msaaTexture.createView() : this.layerTextures[i].createView(),
          resolveTarget: this.sampleCount > 1 ? this.layerTextures[i].createView() : undefined,
          loadOp    : 'clear',
          storeOp   : this.sampleCount > 1 ? 'discard' : 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(lp.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
    }

    // ── Pass 3: compositor – blend + tracer ───────────────────────────────
    this.device.queue.writeBuffer(this.compositorUniformBuf, 0,
      new Float32Array([
        state.tracerIntensity ?? 0.7,
        state.tracerThreshold ?? 0.05,
        0, 0,
      ]));

    const compBG = this.device.createBindGroup({
      layout : this.compositorBGL,
      entries: [
        { binding: 0, resource: this.compositorSampler },
        { binding: 1, resource: this.layerTextures[0].createView() },
        { binding: 2, resource: this.layerTextures[1].createView() },
        { binding: 3, resource: this.layerTextures[2].createView() },
        { binding: 4, resource: { buffer: this.compositorUniformBuf } },
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
    if (this.msaaTexture) this.msaaTexture.destroy();
    this.compositorUniformBuf.destroy();
  }
}
