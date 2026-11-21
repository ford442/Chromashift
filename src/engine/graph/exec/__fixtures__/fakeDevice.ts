/**
 * A recording `GPUDevice` stand-in.
 *
 * The executor's job is bookkeeping — which pass, which pipeline, which
 * bindings, in which order — and bookkeeping is exactly what a fake device can
 * check without an adapter. Shader *content* is pinned separately, by
 * `shaderParity.test.ts` against the pre-refactor goldens.
 */

export interface RecordedPass {
  /** `render` for every pass but a compute pass. */
  kind: 'render' | 'compute';
  /** One entry per colour attachment, as `texture label @ loadOp`. */
  attachments: string[];
  /** The last pipeline set. */
  pipeline: string;
  /** Every pipeline set, in order — a compute pass sets one per kernel. */
  pipelines: string[];
  bindGroup: string;
  draws: number[];
  /** `drawIndirect` / `dispatchWorkgroupsIndirect` calls, as `buffer label @ offset`. */
  indirect: string[];
  /** `dispatchWorkgroups` calls, as `x×y×z`. */
  dispatches: string[];
  /** Vertex buffers bound, as `slot:buffer label`. */
  vertexBuffers: string[];
}

/** A created buffer. */
export interface RecordedBuffer {
  label: string;
  /** The descriptor's own label, when it gave one. */
  name: string;
  size: number;
  usage: number;
  destroyed: boolean;
}

export interface RecordedTexture {
  label: string;
  width: number;
  height: number;
  format: string;
  sampleCount: number;
  destroyed: boolean;
}

/** A created bind group: its label and the texture labels it bound, in order. */
export interface RecordedBindGroup {
  label: string;
  textures: string[];
}

export interface FakeGpu {
  device: GPUDevice;
  passes: RecordedPass[];
  bindGroups: RecordedBindGroup[];
  textures: RecordedTexture[];
  pipelineCount: number;
  bindGroupCount: number;
  bufferWrites: { buffer: string; bytes: number }[];
  /** Every buffer created, in creation order. */
  buffers: RecordedBuffer[];
  /** `clearBuffer` calls, as buffer labels, in order. */
  bufferClears: string[];
  /** Compute pipelines created, as entry point names. */
  computeEntryPoints: string[];
  /** Each buffer's size at creation, by label. */
  bufferSizes: Map<string, number>;
  /** A copy of the bytes last written to each buffer, by label — what the GPU would read. */
  bufferContents: Map<string, Uint8Array>;
  /** Fragment source each created pipeline was built from, in creation order. */
  fragments: string[];
  /** Colour-target formats of each created pipeline, parallel to `fragments`. */
  pipelineTargets: string[][];
  /**
   * Make every shader module whose source contains `marker` a validation
   * error, the way a real device reports WGSL it rejects: not a throw, but an
   * error delivered to the innermost matching `pushErrorScope`.
   */
  rejectShadersContaining(marker: string, message: string): void;
  reset(): void;
}

/** WebGPU's bitflag namespaces are runtime globals the type package does not ship. */
export function installWebGpuConstants(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.GPUTextureUsage ??= {
    COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
  };
  globals.GPUBufferUsage = {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
    ...(globals.GPUBufferUsage as object | undefined),
  };
  globals.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
}

export function createFakeGpu(): FakeGpu {
  installWebGpuConstants();

  const state = {
    passes: [] as RecordedPass[],
    textures: [] as RecordedTexture[],
    pipelineCount: 0,
    bindGroupCount: 0,
    bufferWrites: [] as { buffer: string; bytes: number }[],
    buffers: [] as RecordedBuffer[],
    bufferClears: [] as string[],
    computeEntryPoints: [] as string[],
    bufferSizes: new Map<string, number>(),
    bufferContents: new Map<string, Uint8Array>(),
    fragments: [] as string[],
    pipelineTargets: [] as string[][],
    bindGroups: [] as RecordedBindGroup[],
  };
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}#${(ids += 1)}`;
  const rejected: { marker: string; message: string }[] = [];
  const scopes: { filter: GPUErrorFilter; error: GPUError | null }[] = [];
  const raise = (filter: GPUErrorFilter, message: string) => {
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
      const scope = scopes[i]!;
      if (scope.filter !== filter) continue;
      scope.error ??= { message } as GPUError;
      return;
    }
  };

  const device = {
    features: new Set<string>(),
    limits: {},
    createTexture(descriptor: GPUTextureDescriptor) {
      const size = descriptor.size as number[];
      const record: RecordedTexture = {
        label: nextId('tex'),
        width: size[0]!,
        height: size[1]!,
        format: String(descriptor.format),
        sampleCount: descriptor.sampleCount ?? 1,
        destroyed: false,
      };
      state.textures.push(record);
      return {
        get width() { return record.width; },
        get height() { return record.height; },
        format: record.format,
        label: record.label,
        createView: () => ({ __texture: record.label }),
        destroy: () => { record.destroyed = true; },
      } as unknown as GPUTexture;
    },
    createBuffer(descriptor: GPUBufferDescriptor) {
      const label = nextId('buf');
      state.bufferSizes.set(label, descriptor.size);
      const record: RecordedBuffer = {
        label,
        name: descriptor.label ?? '',
        size: descriptor.size,
        usage: descriptor.usage,
        destroyed: false,
      };
      state.buffers.push(record);
      return { label, size: descriptor.size, destroy: () => { record.destroyed = true; } } as unknown as GPUBuffer;
    },
    createSampler: () => ({ __sampler: nextId('smp') }) as unknown as GPUSampler,
    createShaderModule(descriptor: GPUShaderModuleDescriptor) {
      const rejection = rejected.find(({ marker }) => descriptor.code.includes(marker));
      if (rejection) raise('validation', rejection.message);
      return { __code: descriptor.code } as unknown as GPUShaderModule;
    },
    pushErrorScope(filter: GPUErrorFilter) {
      scopes.push({ filter, error: null });
    },
    popErrorScope() {
      const scope = scopes.pop();
      if (!scope) return Promise.reject(new Error('popErrorScope with no scope pushed'));
      return Promise.resolve(scope.error);
    },
    createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor) {
      return { __entries: descriptor.entries, label: nextId('bgl') } as unknown as GPUBindGroupLayout;
    },
    createPipelineLayout: () => ({}) as unknown as GPUPipelineLayout,
    createRenderPipeline(descriptor: GPURenderPipelineDescriptor) {
      state.pipelineCount += 1;
      const code = (descriptor.fragment?.module as unknown as { __code?: string })?.__code ?? '';
      state.fragments.push(code);
      state.pipelineTargets.push(
        [...(descriptor.fragment?.targets ?? [])].map((target) => String(target?.format)),
      );
      return { label: nextId('pipe'), __targets: descriptor.fragment?.targets } as unknown as GPURenderPipeline;
    },
    createComputePipeline(descriptor: GPUComputePipelineDescriptor) {
      state.computeEntryPoints.push(descriptor.compute.entryPoint ?? '');
      return { label: nextId(`cpipe:${descriptor.compute.entryPoint ?? ''}`) } as unknown as GPUComputePipeline;
    },
    createBindGroup(descriptor: GPUBindGroupDescriptor) {
      state.bindGroupCount += 1;
      const label = nextId('bg');
      state.bindGroups.push({
        label,
        textures: [...descriptor.entries]
          .map((entry) => (entry.resource as { __texture?: string })?.__texture)
          .filter((texture): texture is string => typeof texture === 'string'),
      });
      return { label, __entries: descriptor.entries } as unknown as GPUBindGroup;
    },
    createCommandEncoder() {
      return {
        beginRenderPass(descriptor: GPURenderPassDescriptor) {
          const attachments = [...(descriptor.colorAttachments as GPURenderPassColorAttachment[])]
            .filter((attachment) => attachment !== null)
            .map((attachment) => {
              const view = attachment.view as unknown as { __texture: string };
              const resolve = attachment.resolveTarget as unknown as { __texture?: string } | undefined;
              return resolve
                ? `${view.__texture}->${resolve.__texture}@${attachment.loadOp}`
                : `${view.__texture}@${attachment.loadOp}`;
            });
          const pass = recordedPass('render', attachments);
          state.passes.push(pass);
          return {
            setPipeline: (pipeline: GPURenderPipeline) => { pass.pipeline = pipeline.label; pass.pipelines.push(pipeline.label); },
            setBindGroup: (_index: number, group: GPUBindGroup) => { pass.bindGroup = group.label; },
            setVertexBuffer: (slot: number, buffer: GPUBuffer) => { pass.vertexBuffers.push(`${slot}:${buffer.label}`); },
            draw: (count: number) => { pass.draws.push(count); },
            drawIndirect: (buffer: GPUBuffer, offset: number) => { pass.indirect.push(`${buffer.label}@${offset}`); },
            end: () => {},
          } as unknown as GPURenderPassEncoder;
        },
        beginComputePass() {
          const pass = recordedPass('compute', []);
          state.passes.push(pass);
          return {
            setPipeline: (pipeline: GPUComputePipeline) => { pass.pipeline = pipeline.label; pass.pipelines.push(pipeline.label); },
            setBindGroup: (_index: number, group: GPUBindGroup) => { pass.bindGroup = group.label; },
            dispatchWorkgroups: (x: number, y = 1, z = 1) => { pass.dispatches.push(`${x}×${y}×${z}`); },
            dispatchWorkgroupsIndirect: (buffer: GPUBuffer, offset: number) => { pass.indirect.push(`${buffer.label}@${offset}`); },
            end: () => {},
          } as unknown as GPUComputePassEncoder;
        },
        clearBuffer(buffer: GPUBuffer) {
          state.bufferClears.push(buffer.label);
        },
        finish: () => ({}) as GPUCommandBuffer,
      } as unknown as GPUCommandEncoder;
    },
    queue: {
      writeBuffer(
        buffer: GPUBuffer,
        _offset: number,
        data: ArrayBuffer | ArrayBufferView,
        dataOffset = 0,
        size?: number,
      ) {
        state.bufferWrites.push({
          buffer: buffer.label,
          bytes: 'byteLength' in data ? data.byteLength : 0,
        });
        // `writeBuffer` copies at call time, so a writer that reuses one scratch
        // block for several buffers must still leave each with its own bytes.
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        const elementSize = ArrayBuffer.isView(data) && 'BYTES_PER_ELEMENT' in data
          ? (data as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT
          : 1;
        const start = dataOffset * elementSize;
        const end = size === undefined ? bytes.byteLength : start + size * elementSize;
        state.bufferContents.set(buffer.label, bytes.slice(start, end));
      },
      writeTexture: () => {},
      submit: () => {},
    },
  } as unknown as GPUDevice;

  return {
    device,
    get passes() { return state.passes; },
    get bindGroups() { return state.bindGroups; },
    get textures() { return state.textures; },
    get pipelineCount() { return state.pipelineCount; },
    get bindGroupCount() { return state.bindGroupCount; },
    get bufferWrites() { return state.bufferWrites; },
    get buffers() { return state.buffers; },
    get bufferClears() { return state.bufferClears; },
    get computeEntryPoints() { return state.computeEntryPoints; },
    get bufferSizes() { return state.bufferSizes; },
    get bufferContents() { return state.bufferContents; },
    get fragments() { return state.fragments; },
    get pipelineTargets() { return state.pipelineTargets; },
    rejectShadersContaining(marker: string, message: string) {
      rejected.push({ marker, message });
    },
    reset() {
      state.passes.length = 0;
      state.bufferWrites.length = 0;
      state.bufferClears.length = 0;
      state.bindGroups.length = 0;
      state.bindGroupCount = 0;
    },
  };
}

function recordedPass(kind: RecordedPass['kind'], attachments: string[]): RecordedPass {
  return {
    kind,
    attachments,
    pipeline: '',
    pipelines: [],
    bindGroup: '',
    draws: [],
    indirect: [],
    dispatches: [],
    vertexBuffers: [],
  };
}

/** A minimal `RendererState` — every optional field left at its default. */
export function fakeRendererState(overrides: Record<string, unknown> = {}) {
  return {
    layers: [
      { angleDeg: 0 }, { angleDeg: 12 }, { angleDeg: 24 },
    ],
    avgLuminance: 128,
    ...overrides,
  } as never;
}
