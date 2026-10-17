/**
 * Bind-group layouts read off the shader that declares the bindings.
 *
 * A layout written by hand next to a shader written elsewhere is two copies of
 * one fact, and the copies drift silently: the device only notices when a
 * pipeline is created, and a pass-graph shader nobody has looked at (an editor
 * graph, a new node kind) would be the first to find out. So the graph
 * executor builds each pipeline's layout *from* its emitted WGSL instead —
 * every `@group(0) @binding(n) var… : T` becomes the entry WebGPU requires for
 * `T`, with the visibility of the stage whose module declared it.
 *
 * This is deliberately a declaration scanner, not a WGSL parser: it runs on the
 * boot path, and a full parser is ~200 kB. It is held to the full parser
 * instead — `shaderBindings.test.ts` checks it against `wgsl_reflect` for every
 * shader the app can emit, and checks every hand-written layout left in the
 * codebase against `wgsl_reflect` too. CI then runs `naga --validate` over the
 * same dump (`npm run shaders:validate`).
 *
 * What the declaration cannot say is intent: a `texture_2d<f32>` binding could
 * be bound to a filterable or an unfilterable-float texture, and the layout
 * has to commit to one. The default is `float` (filterable); pass an override
 * for the binding where that is wrong (an `r32float` plane, say).
 */

export type ReflectedResource =
  | { type: 'buffer'; buffer: GPUBufferBindingLayout }
  | { type: 'sampler'; sampler: GPUSamplerBindingLayout }
  | { type: 'texture'; texture: GPUTextureBindingLayout }
  | { type: 'storageTexture'; storageTexture: GPUStorageTextureBindingLayout }
  | { type: 'externalTexture'; externalTexture: GPUExternalTextureBindingLayout };

export interface ReflectedBinding {
  group: number;
  binding: number;
  name: string;
  resource: ReflectedResource;
}

export interface ShaderStageSource {
  code: string;
  /** `GPUShaderStage` bits for the stage this module is bound at. */
  visibility: number;
}

/** Per-binding corrections where the declaration cannot express intent. */
export type BindingOverrides = Readonly<Record<number, Partial<Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'>>>>;

const SAMPLE_TYPES: Record<string, GPUTextureSampleType> = { f32: 'float', i32: 'sint', u32: 'uint' };

const VIEW_DIMENSIONS: Record<string, GPUTextureViewDimension> = {
  '1d': '1d',
  '2d': '2d',
  '2d_array': '2d-array',
  '3d': '3d',
  cube: 'cube',
  cube_array: 'cube-array',
};

const STORAGE_ACCESS: Record<string, GPUStorageTextureAccess> = {
  read: 'read-only',
  write: 'write-only',
  read_write: 'read-write',
};

/** Strip `//` and (nestable) block comments, so a commented-out binding is not reflected. */
function stripComments(source: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const two = source.slice(i, i + 2);
    if (depth === 0 && two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (two === '/*') {
      depth += 1;
      i += 1;
    } else if (depth > 0 && two === '*/') {
      depth -= 1;
      i += 1;
      out += ' ';
    } else if (depth === 0) {
      out += source[i];
    }
  }
  return out;
}

/** The `<…>` template arguments of `type`, split on top-level commas. */
function templateArgs(type: string): string[] {
  const open = type.indexOf('<');
  if (open < 0) return [];
  const inner = type.slice(open + 1, type.lastIndexOf('>'));
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '<') depth += 1;
    else if (inner[i] === '>') depth -= 1;
    else if (inner[i] === ',' && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return args.filter((arg) => arg !== '');
}

function resourceFor(addressSpace: string | undefined, type: string, where: string): ReflectedResource {
  if (addressSpace !== undefined) {
    const [space, access] = addressSpace.split(',').map((part) => part.trim());
    if (space === 'uniform') return { type: 'buffer', buffer: { type: 'uniform' } };
    if (space === 'storage') {
      return { type: 'buffer', buffer: { type: access === 'read_write' ? 'storage' : 'read-only-storage' } };
    }
    throw new Error(`${where}: address space <${addressSpace}> cannot be bound`);
  }

  const base = type.split('<')[0].trim();
  if (base === 'sampler') return { type: 'sampler', sampler: { type: 'filtering' } };
  if (base === 'sampler_comparison') return { type: 'sampler', sampler: { type: 'comparison' } };
  if (base === 'texture_external') return { type: 'externalTexture', externalTexture: {} };

  const storage = /^texture_storage_(\w+)$/.exec(base);
  if (storage) {
    const [format, access] = templateArgs(type);
    return {
      type: 'storageTexture',
      storageTexture: {
        format: format as GPUTextureFormat,
        access: STORAGE_ACCESS[access] ?? 'write-only',
        viewDimension: VIEW_DIMENSIONS[storage[1]],
      },
    };
  }

  const depth = /^texture_depth_(multisampled_)?(\w+)$/.exec(base);
  if (depth) {
    return {
      type: 'texture',
      texture: { sampleType: 'depth', viewDimension: VIEW_DIMENSIONS[depth[2]], multisampled: Boolean(depth[1]) },
    };
  }

  const sampled = /^texture_(multisampled_)?(\w+)$/.exec(base);
  if (sampled && VIEW_DIMENSIONS[sampled[2]]) {
    const [component] = templateArgs(type);
    const sampleType = SAMPLE_TYPES[component];
    if (!sampleType) throw new Error(`${where}: unsupported texture component type "${component}"`);
    return {
      type: 'texture',
      texture: { sampleType, viewDimension: VIEW_DIMENSIONS[sampled[2]], multisampled: Boolean(sampled[1]) },
    };
  }

  throw new Error(`${where}: "${type}" is not a bindable resource type`);
}

/** Every module-scope `@group/@binding` declaration in `source`, in source order. */
export function reflectBindings(source: string): ReflectedBinding[] {
  const code = stripComments(source);
  // One or more attributes, then `var`, an optional `<address space>`, the
  // name, and the type up to the `;`.
  const declaration = /((?:@\s*\w+\s*(?:\([^)]*\))?\s*)+)var\s*(?:<([^>]*)>)?\s*(\w+)\s*:\s*([^;]+);/g;
  const bindings: ReflectedBinding[] = [];
  for (const match of code.matchAll(declaration)) {
    const [, attributes, addressSpace, name, type] = match;
    const group = /@\s*group\s*\(\s*(\d+)\s*\)/.exec(attributes);
    const binding = /@\s*binding\s*\(\s*(\d+)\s*\)/.exec(attributes);
    if (!group || !binding) continue;
    bindings.push({
      group: Number(group[1]),
      binding: Number(binding[1]),
      name,
      resource: resourceFor(addressSpace, type.trim(), `binding ${name}`),
    });
  }
  return bindings;
}

/**
 * The group-0 layout entries a pipeline built from `stages` needs.
 *
 * A binding declared by more than one stage's module (a vertex + fragment
 * module pair, or one module serving both) must declare the same resource in
 * each; its visibility is the union. Entries come back sorted by binding.
 */
export function layoutFromReflection(
  stages: readonly ShaderStageSource[],
  overrides: BindingOverrides = {},
): GPUBindGroupLayoutEntry[] {
  const entries = new Map<number, { visibility: number; resource: ReflectedResource; name: string }>();
  for (const stage of stages) {
    for (const reflected of reflectBindings(stage.code)) {
      if (reflected.group !== 0) {
        throw new Error(`binding ${reflected.name}: only @group(0) is laid out, found @group(${reflected.group})`);
      }
      const existing = entries.get(reflected.binding);
      if (!existing) {
        entries.set(reflected.binding, { visibility: stage.visibility, resource: reflected.resource, name: reflected.name });
        continue;
      }
      if (JSON.stringify(existing.resource) !== JSON.stringify(reflected.resource)) {
        throw new Error(
          `@binding(${reflected.binding}) is declared as two different resources `
          + `(${existing.name}, ${reflected.name}) by the stages of one pipeline`,
        );
      }
      existing.visibility |= stage.visibility;
    }
  }
  for (const binding of Object.keys(overrides).map(Number)) {
    if (!entries.has(binding)) throw new Error(`override for @binding(${binding}), which no stage declares`);
  }
  return [...entries.entries()]
    .sort(([a], [b]) => a - b)
    .map(([binding, { visibility, resource }]) => ({
      binding,
      visibility,
      ...layoutFields(resource),
      ...overrides[binding],
    }));
}

/** The one `GPUBindGroupLayoutEntry` member a resource sets. */
function layoutFields(resource: ReflectedResource): Partial<GPUBindGroupLayoutEntry> {
  switch (resource.type) {
    case 'buffer':
      return { buffer: resource.buffer };
    case 'sampler':
      return { sampler: resource.sampler };
    case 'texture':
      return { texture: resource.texture };
    case 'storageTexture':
      return { storageTexture: resource.storageTexture };
    case 'externalTexture':
      return { externalTexture: resource.externalTexture };
  }
}
