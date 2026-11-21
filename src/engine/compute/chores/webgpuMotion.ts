/**
 * `motion-field` on the WebGPU lane: the per-cell luminance difference
 * (Stage 1) and the two-pass Lucas–Kanade flow on top of it (Stage 2). Part
 * of `WebGpuChoreBackend` (`webgpuBackend.ts`).
 *
 * The flow pipelines and textures are built on first use, so a session that
 * never selects `motionMode: 'direction'` never compiles either one.
 */
import {
  MOTION_FIELD_COMPUTE_SHADER,
  MOTION_FLOW_COARSE_COMPUTE_SHADER,
  MOTION_FLOW_REFINE_COMPUTE_SHADER,
} from './kernels';
import { EMPTY_MOTION_FIELD_STATS, motionFieldSize, type MotionFieldStats } from './motionKernel';
import { isSrgbTextureFormat } from './support';
import type { GpuMotionFieldOutput } from './types';
import { workgroupsFor } from './webgpuShared';

/** Per-frame parameters the motion-field compute pass needs, minus geometry. */
export interface MotionFieldEncodeParams {
  /** Resolution divisor; the field is `ceil(width / divisor)` wide. */
  divisor: number;
  /** Noise floor on the normalised luminance difference, in [0,1). */
  threshold: number;
  /** Drop the previous-frame history (source switch, seek, resize). */
  reset: boolean;
}

type Slot = 0 | 1;
type PerSlot<T> = [T | null, T | null];

interface FieldPipeline {
  pipeline: GPUComputePipeline;
  layout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer;
  statsBuffer: GPUBuffer;
  statsStagingBuffer: GPUBuffer;
}

/** The field and its ping-ponged luminance history, at one geometry. */
interface FieldTargets {
  field: GPUTexture;
  /** Previous/next luminance — one float per field cell. */
  lum: [GPUTexture, GPUTexture];
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Indexed by the luminance write slot. */
  bindGroups: PerSlot<GPUBindGroup>;
  bindGroupSource: GPUTexture | null;
}

interface FlowPipelines {
  coarse: GPUComputePipeline;
  refine: GPUComputePipeline;
  coarseLayout: GPUBindGroupLayout;
  refineLayout: GPUBindGroupLayout;
  uniformBuffer: GPUBuffer;
}

/** The flow's coarse seed and combined output, at the field's geometry. */
interface FlowTargets {
  /** Half-field-resolution seed the refine pass upsamples. */
  coarse: GPUTexture;
  /** Field resolution, `(magnitude, vx, vy, 1)` — what persistence binds. */
  field: GPUTexture;
  coarseWidth: number;
  coarseHeight: number;
  /** Indexed by the luminance write slot, like `FieldTargets.bindGroups`. */
  coarseBindGroups: PerSlot<GPUBindGroup>;
  refineBindGroups: PerSlot<GPUBindGroup>;
}

export class GpuMotionPass {
  private readonly device: GPUDevice;
  private fieldPipeline: FieldPipeline | null = null;
  private fieldTargets: FieldTargets | null = null;
  private flowPipelines: FlowPipelines | null = null;
  private flowTargets: FlowTargets | null = null;
  private lumSlot: Slot = 0;
  private historyValid = false;
  /** Set by `encodeFieldInto`, consumed by `encodeFlowInto`. */
  private flowPending: { readSlot: Slot; writeSlot: Slot; reset: boolean } | null = null;
  private hasFlow = false;
  private statsMapPending = false;
  private lastStats: MotionFieldStats = EMPTY_MOTION_FIELD_STATS;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Encode the motion-field compute pass into a caller-owned encoder. Nothing
   * is read back here — the field is a `GPUTexture` the persistence pass
   * binds directly, and the summary statistics accumulate into a 16-byte
   * storage buffer that {@link pollStats} maps on the caller's own (much
   * slower) cadence.
   */
  encodeFieldInto(
    enc: GPUCommandEncoder,
    source: GPUTexture,
    width: number,
    height: number,
    params: MotionFieldEncodeParams,
  ): GpuMotionFieldOutput {
    const p = this.ensureFieldPipeline();
    const divisor = Math.max(1, Math.floor(params.divisor));
    const { targets, resized } = this.ensureFieldTargets(width, height, divisor);
    // A resize throws the history away, so the first field after it must be
    // zero rather than a difference against an unrelated frame.
    const reset = params.reset || resized || !this.historyValid;

    const readSlot = this.lumSlot;
    const writeSlot: Slot = readSlot === 0 ? 1 : 0;

    const uniformData = new ArrayBuffer(32);
    const u32 = new Uint32Array(uniformData);
    const f32 = new Float32Array(uniformData);
    u32[0] = width;
    u32[1] = height;
    u32[2] = targets.width;
    u32[3] = targets.height;
    u32[4] = divisor;
    u32[5] = reset ? 1 : 0;
    u32[6] = isSrgbTextureFormat(source.format) ? 1 : 0;
    f32[7] = params.threshold;
    this.device.queue.writeBuffer(p.uniformBuffer, 0, uniformData);
    // Statistics are per-frame, not cumulative.
    this.device.queue.writeBuffer(p.statsBuffer, 0, new Uint32Array(4));

    if (targets.bindGroupSource !== source) {
      targets.bindGroups = [null, null];
      targets.bindGroupSource = source;
    }
    let bindGroup = targets.bindGroups[writeSlot];
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        layout: p.layout,
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: targets.lum[readSlot].createView() },
          { binding: 2, resource: targets.field.createView() },
          { binding: 3, resource: targets.lum[writeSlot].createView() },
          { binding: 4, resource: { buffer: p.statsBuffer } },
          { binding: 5, resource: { buffer: p.uniformBuffer } },
        ],
      });
      targets.bindGroups[writeSlot] = bindGroup;
    }

    const pass = enc.beginComputePass();
    pass.setPipeline(p.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(workgroupsFor(targets.width), workgroupsFor(targets.height));
    pass.end();

    this.lumSlot = writeSlot;
    this.historyValid = true;
    // The flow pass reads the same two history slots this dispatch just used,
    // so it has to run before the next field encode flips them.
    this.flowPending = { readSlot, writeSlot, reset };
    this.hasFlow = false;

    return {
      kind: 'gpu-motion-field',
      fieldTexture: targets.field,
      width: targets.width,
      height: targets.height,
      hasFlow: false,
    };
  }

  /**
   * Encode the two Lucas–Kanade dispatches on top of the field this encoder's
   * last {@link encodeFieldInto} produced, and return the *combined*
   * `(magnitude, vx, vy, 1)` texture the persistence pass should bind instead.
   * `null` when no field has been encoded into this encoder yet, which leaves
   * the caller on the Stage 1 texture rather than a blank one.
   */
  encodeFlowInto(enc: GPUCommandEncoder): GPUTexture | null {
    const pending = this.flowPending;
    const field = this.fieldTargets;
    if (!pending || !field) return null;
    this.flowPending = null;

    const p = this.ensureFlowPipelines();
    const flow = this.ensureFlowTargets(field);

    const uniformData = new Uint32Array(8);
    uniformData[0] = field.width;
    uniformData[1] = field.height;
    uniformData[2] = flow.coarseWidth;
    uniformData[3] = flow.coarseHeight;
    uniformData[4] = pending.reset ? 1 : 0;
    this.device.queue.writeBuffer(p.uniformBuffer, 0, uniformData);

    const prevView = field.lum[pending.readSlot].createView();
    const curView = field.lum[pending.writeSlot].createView();

    let coarseBindGroup = flow.coarseBindGroups[pending.writeSlot];
    if (!coarseBindGroup) {
      coarseBindGroup = this.device.createBindGroup({
        layout: p.coarseLayout,
        entries: [
          { binding: 0, resource: prevView },
          { binding: 1, resource: curView },
          { binding: 2, resource: flow.coarse.createView() },
          { binding: 3, resource: { buffer: p.uniformBuffer } },
        ],
      });
      flow.coarseBindGroups[pending.writeSlot] = coarseBindGroup;
    }

    let refineBindGroup = flow.refineBindGroups[pending.writeSlot];
    if (!refineBindGroup) {
      refineBindGroup = this.device.createBindGroup({
        layout: p.refineLayout,
        entries: [
          { binding: 0, resource: prevView },
          { binding: 1, resource: curView },
          { binding: 2, resource: flow.coarse.createView() },
          { binding: 3, resource: field.field.createView() },
          { binding: 4, resource: flow.field.createView() },
          { binding: 5, resource: { buffer: p.uniformBuffer } },
        ],
      });
      flow.refineBindGroups[pending.writeSlot] = refineBindGroup;
    }

    const coarsePass = enc.beginComputePass();
    coarsePass.setPipeline(p.coarse);
    coarsePass.setBindGroup(0, coarseBindGroup);
    coarsePass.dispatchWorkgroups(workgroupsFor(flow.coarseWidth), workgroupsFor(flow.coarseHeight));
    coarsePass.end();

    // A separate pass, not a second dispatch in the same one: the refine
    // kernel reads every coarse cell its window touches, so it needs the
    // coarse writes to be visible, which only a pass boundary guarantees.
    const refinePass = enc.beginComputePass();
    refinePass.setPipeline(p.refine);
    refinePass.setBindGroup(0, refineBindGroup);
    refinePass.dispatchWorkgroups(workgroupsFor(field.width), workgroupsFor(field.height));
    refinePass.end();

    this.hasFlow = true;
    return flow.field;
  }

  /** True when the last encoded frame carried a solved velocity in `gb`. */
  carriesFlow(): boolean {
    return this.hasFlow;
  }

  /** The field texture the last `encodeFieldInto` wrote, if any. */
  fieldTexture(): GPUTexture | null {
    return this.fieldTargets?.field ?? null;
  }

  /** Last summary statistics read back, or zeros before the first read. */
  stats(): MotionFieldStats {
    return this.lastStats;
  }

  /**
   * Copy and map the 16-byte statistics buffer. Safe to call at any rate: a
   * call made while a previous map is in flight is dropped rather than queued.
   */
  pollStats(): void {
    const p = this.fieldPipeline;
    if (!p || this.statsMapPending) return;
    this.statsMapPending = true;

    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(p.statsBuffer, 0, p.statsStagingBuffer, 0, 16);
    this.device.queue.submit([enc.finish()]);

    const staging = p.statsStagingBuffer;
    void staging.mapAsync(GPUMapMode.READ).then(() => {
      const view = new Uint32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      this.statsMapPending = false;
      // The staging copy is a fixed 16 bytes: four u32 counters.
      const [magnitudeSum, moving, cells] = view as unknown as readonly [number, number, number, number];
      this.lastStats = cells === 0
        ? EMPTY_MOTION_FIELD_STATS
        : { meanMagnitude: magnitudeSum / 1000 / cells, movingFraction: moving / cells, cells };
    }).catch(() => {
      this.statsMapPending = false;
    });
  }

  destroy(): void {
    this.destroyTargets();
    const field = this.fieldPipeline;
    this.fieldPipeline = null;
    field?.uniformBuffer.destroy();
    field?.statsBuffer.destroy();
    field?.statsStagingBuffer.destroy();
    this.flowPipelines?.uniformBuffer.destroy();
    this.flowPipelines = null;
    this.lastStats = EMPTY_MOTION_FIELD_STATS;
  }

  private destroyTargets(): void {
    const field = this.fieldTargets;
    const flow = this.flowTargets;
    this.fieldTargets = null;
    this.flowTargets = null;
    field?.field.destroy();
    field?.lum[0].destroy();
    field?.lum[1].destroy();
    flow?.coarse.destroy();
    flow?.field.destroy();
    this.flowPending = null;
    this.hasFlow = false;
    this.lumSlot = 0;
    this.historyValid = false;
  }

  /** The targets at this geometry; `resized` when the history was dropped and the next field is all-zero. */
  private ensureFieldTargets(
    width: number,
    height: number,
    divisor: number,
  ): { targets: FieldTargets; resized: boolean } {
    const size = motionFieldSize(width, height, divisor);
    const current = this.fieldTargets;
    if (
      current
      && current.width === size.width && current.height === size.height
      && current.sourceWidth === width && current.sourceHeight === height
    ) {
      return { targets: current, resized: false };
    }

    this.destroyTargets();
    const storage = (format: GPUTextureFormat) => this.device.createTexture({
      size: [size.width, size.height, 1],
      format,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.fieldTargets = {
      field: storage('rgba16float'),
      lum: [storage('r32float'), storage('r32float')],
      width: size.width,
      height: size.height,
      sourceWidth: width,
      sourceHeight: height,
      bindGroups: [null, null],
      bindGroupSource: null,
    };
    return { targets: this.fieldTargets, resized: true };
  }

  private ensureFieldPipeline(): FieldPipeline {
    if (this.fieldPipeline) return this.fieldPipeline;
    const { device } = this;
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'r32float', viewDimension: '2d' },
        },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    this.fieldPipeline = {
      layout,
      pipeline: device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: device.createShaderModule({ code: MOTION_FIELD_COMPUTE_SHADER }), entryPoint: 'motion_field_main' },
      }),
      uniformBuffer: device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      statsBuffer: device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }),
      statsStagingBuffer: device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    };
    return this.fieldPipeline;
  }

  /**
   * Compile the two flow pipelines. Called only from `encodeFlowInto`, so
   * `motionMode: off | boost | gate` never pays for either shader module.
   */
  private ensureFlowPipelines(): FlowPipelines {
    if (this.flowPipelines) return this.flowPipelines;
    const { device } = this;

    // r32float is not filterable without an optional feature, so both history
    // planes are declared unfilterable and every read is a `textureLoad` —
    // which is what the CPU mirrors do too (a clamped fetch, not a sampler).
    const lumEntry = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      texture: { sampleType: 'unfilterable-float' },
    });
    const flowOut = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
    });
    const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: 'uniform' },
    });

    const coarseLayout = device.createBindGroupLayout({
      entries: [lumEntry(0), lumEntry(1), flowOut(2), uniform(3)],
    });
    const refineLayout = device.createBindGroupLayout({
      entries: [
        lumEntry(0),
        lumEntry(1),
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        flowOut(4),
        uniform(5),
      ],
    });
    this.flowPipelines = {
      coarseLayout,
      refineLayout,
      coarse: device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [coarseLayout] }),
        compute: {
          module: device.createShaderModule({ code: MOTION_FLOW_COARSE_COMPUTE_SHADER }),
          entryPoint: 'motion_flow_coarse_main',
        },
      }),
      refine: device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [refineLayout] }),
        compute: {
          module: device.createShaderModule({ code: MOTION_FLOW_REFINE_COMPUTE_SHADER }),
          entryPoint: 'motion_flow_refine_main',
        },
      }),
      uniformBuffer: device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    };
    return this.flowPipelines;
  }

  /**
   * The coarse seed and the combined output at the field's geometry. A field
   * resize drops both (`destroyTargets`), so this only allocates on the first
   * flow frame after a geometry change.
   *
   * `rgba16float` for both, not `rg16float`: only the former is a core
   * storage-texture format, and a feature request for the narrower one is not
   * worth the extra failure mode on one quarter-scale texture.
   */
  private ensureFlowTargets(field: FieldTargets): FlowTargets {
    if (this.flowTargets) return this.flowTargets;
    const coarseWidth = Math.max(1, Math.ceil(field.width / 2));
    const coarseHeight = Math.max(1, Math.ceil(field.height / 2));
    const storage = (width: number, height: number) => this.device.createTexture({
      size: [width, height, 1],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.flowTargets = {
      coarse: storage(coarseWidth, coarseHeight),
      field: storage(field.width, field.height),
      coarseWidth,
      coarseHeight,
      coarseBindGroups: [null, null],
      refineBindGroups: [null, null],
    };
    return this.flowTargets;
  }
}
