/**
 * A recording `GPUDevice` stand-in.
 *
 * The executor's job is bookkeeping — which pass, which pipeline, which
 * bindings, in which order — and bookkeeping is exactly what a fake device can
 * check without an adapter. Shader *content* is pinned separately, by
 * `shaderParity.test.ts` against the pre-refactor goldens.
 */

export interface RecordedPass {
  /** One entry per colour attachment, as `texture label @ loadOp`. */
  attachments: string[];
  pipeline: string;
  bindGroup: string;
  draws: number[];
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
  /** Fragment source each created pipeline was built from, in creation order. */
  fragments: string[];
  reset(): void;
}

/** WebGPU's bitflag namespaces are runtime globals the type package does not ship. */
export function installWebGpuConstants(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.GPUTextureUsage ??= {
    COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
  };
  globals.GPUBufferUsage ??= { COPY_DST: 8, UNIFORM: 64 };
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
    fragments: [] as string[],
    bindGroups: [] as RecordedBindGroup[],
  };
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}#${(ids += 1)}`;

  const device = {
    features: new Set<string>(),
    limits: {},
    createTexture(descriptor: GPUTextureDescriptor) {
      const size = descriptor.size as number[];
      const record: RecordedTexture = {
        label: nextId('tex'),
        width: size[0],
        height: size[1],
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
    createBuffer() {
      const label = nextId('buf');
      return { label, destroy: () => {} } as unknown as GPUBuffer;
    },
    createSampler: () => ({ __sampler: nextId('smp') }) as unknown as GPUSampler,
    createShaderModule(descriptor: GPUShaderModuleDescriptor) {
      return { __code: descriptor.code } as unknown as GPUShaderModule;
    },
    createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor) {
      return { __entries: descriptor.entries, label: nextId('bgl') } as unknown as GPUBindGroupLayout;
    },
    createPipelineLayout: () => ({}) as unknown as GPUPipelineLayout,
    createRenderPipeline(descriptor: GPURenderPipelineDescriptor) {
      state.pipelineCount += 1;
      const code = (descriptor.fragment?.module as unknown as { __code?: string })?.__code ?? '';
      state.fragments.push(code);
      return { label: nextId('pipe'), __targets: descriptor.fragment?.targets } as unknown as GPURenderPipeline;
    },
    createComputePipeline: () => ({}) as unknown as GPUComputePipeline,
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
          const pass: RecordedPass = { attachments, pipeline: '', bindGroup: '', draws: [] };
          state.passes.push(pass);
          return {
            setPipeline: (pipeline: GPURenderPipeline) => { pass.pipeline = pipeline.label; },
            setBindGroup: (_index: number, group: GPUBindGroup) => { pass.bindGroup = group.label; },
            draw: (count: number) => { pass.draws.push(count); },
            end: () => {},
          } as unknown as GPURenderPassEncoder;
        },
        finish: () => ({}) as GPUCommandBuffer,
      } as unknown as GPUCommandEncoder;
    },
    queue: {
      writeBuffer(buffer: GPUBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView) {
        state.bufferWrites.push({
          buffer: buffer.label,
          bytes: 'byteLength' in data ? data.byteLength : 0,
        });
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
    get fragments() { return state.fragments; },
    reset() {
      state.passes.length = 0;
      state.bufferWrites.length = 0;
      state.bindGroups.length = 0;
      state.bindGroupCount = 0;
    },
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
