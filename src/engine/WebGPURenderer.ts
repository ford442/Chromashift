/**
 * WebGPURenderer
 *
 * Manages a 3-layer rendering pipeline:
 *   Layer 0 – Red / Orange  (front)
 *   Layer 1 – Violet / Blue (middle)
 *   Layer 2 – Green / Yellow (back)
 *
 * Each layer has:
 *  • an independent rotation angle (radians) applied via a mat3x3 uniform
 *  • a colour-channel mask implemented entirely in the fragment shader
 *
 * All composition happens on the GPU; there is zero CPU-side pixel
 * manipulation.
 */

import {
  vertexShaderSource,
  fragmentShaderRedOrange,
  fragmentShaderVioletBlue,
  fragmentShaderGreenYellow,
} from './shaders';

export interface LayerState {
  /** Rotation angle in degrees */
  angleDeg: number;
  /** Horizontal flip (scaleX) */
  flipX?: boolean;
  /** Vertical flip (scaleY) */
  flipY?: boolean;
}

export interface RendererState {
  layers: [LayerState, LayerState, LayerState];
  /** Average luminance [0–255] used for colour-depth modulation */
  avgLuminance: number;
  /** Layer opacity [0.0–1.0] applied to all layers */
  layerOpacity?: number;
}

/** Build a column-major mat3x3 rotation matrix (z-axis) for WGSL. */
function buildRotationMat3(angleDeg: number): Float32Array {
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // WGSL mat3x3 is stored column-major with std140 padding:
  // each vec3 column is padded to 16 bytes (4 floats).
  // col0: [c, s, 0, 0], col1: [-s, c, 0, 0], col2: [0, 0, 1, 0]
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0]);
}

interface LayerPipeline {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
  rotationBuffer: GPUBuffer;
  fragUniformBuffer: GPUBuffer;
}

export class WebGPURenderer {
  private device: GPUDevice;
  private context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private sampler: GPUSampler;
  private layerPipelines: LayerPipeline[] = [];
  private currentTexture: GPUTexture | null = null;

  constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat) {
    this.device = device;
    this.context = context;
    this.format = format;

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });

    const fragmentSources = [
      fragmentShaderRedOrange,
      fragmentShaderVioletBlue,
      fragmentShaderGreenYellow,
    ];

    for (const fragSrc of fragmentSources) {
      this.layerPipelines.push(this.createLayerPipeline(fragSrc));
    }
  }

  private createLayerPipeline(fragmentSource: string): LayerPipeline {
    const device = this.device;

    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    const vertModule = device.createShaderModule({ code: vertexShaderSource });
    const fragModule = device.createShaderModule({ code: fragmentSource });

    const pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: vertModule,
        entryPoint: 'main',
      },
      fragment: {
        module: fragModule,
        entryPoint: 'main',
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add',
              },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });

    // Rotation uniform: mat3x3 (48 bytes) + flipX (4 bytes) + flipY (4 bytes) + padding = 64 bytes
    const rotationBuffer = device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Fragment uniform: avgLuminance (f32) + layerOpacity (f32) + 2× padding = 16 bytes
    const fragUniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    return { pipeline, bindGroupLayout, rotationBuffer, fragUniformBuffer };
  }

  /** Replace the source texture used by all layers. */
  setTexture(texture: GPUTexture): void {
    this.currentTexture = texture;
  }

  /** Render one frame with the given per-layer state. */
  render(state: RendererState): void {
    if (!this.currentTexture) return;

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    for (let i = 0; i < 3; i++) {
      const lp = this.layerPipelines[i];
      const layer = state.layers[i];

      // Upload rotation matrix + flip flags
      const rotMat = buildRotationMat3(layer.angleDeg);
      const flipX = layer.flipX ? 1 : 0;
      const flipY = layer.flipY ? 1 : 0;

      // Create combined buffer: mat3x3 (48 bytes) + flipX (4 bytes) + flipY (4 bytes) + padding (8 bytes)
      const combinedData = new ArrayBuffer(64);
      new Float32Array(combinedData).set(rotMat);
      new Uint32Array(combinedData, 48).set([flipX, flipY]);

      this.device.queue.writeBuffer(lp.rotationBuffer, 0, combinedData);

      // Upload fragment uniforms (avg luminance + layer opacity + padding)
      const opacity = state.layerOpacity ?? 1.0;
      const fragData = new Float32Array([state.avgLuminance, opacity, 0, 0]);
      this.device.queue.writeBuffer(lp.fragUniformBuffer, 0, fragData);

      const bindGroup = this.device.createBindGroup({
        layout: lp.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: lp.rotationBuffer } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.currentTexture.createView() },
          { binding: 3, resource: { buffer: lp.fragUniformBuffer } },
        ],
      });

      const passDescriptor: GPURenderPassDescriptor = {
        colorAttachments: [
          {
            view: textureView,
            loadOp: i === 0 ? 'clear' : 'load',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      };

      const pass = commandEncoder.beginRenderPass(passDescriptor);
      pass.setPipeline(lp.pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
      pass.end();
    }

    this.device.queue.submit([commandEncoder.finish()]);
  }

  /** Release all GPU resources. */
  destroy(): void {
    for (const lp of this.layerPipelines) {
      lp.rotationBuffer.destroy();
      lp.fragUniformBuffer.destroy();
    }
  }
}
