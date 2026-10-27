/**
 * Shader ↔ bind-group layout, checked without a GPU.
 *
 * Every pipeline the app builds (see `__fixtures__/shaderCorpus.ts`) is parsed
 * by `wgsl_reflect`, a full WGSL parser, and its reflected `@group(0)` bindings
 * must equal the layout the pipeline was created with — binding for binding,
 * resource type, texture sample type and dimension, storage format and access,
 * and the stage visibility of whichever entry point uses it. A layout written
 * by hand that drifts from its shader fails here instead of at
 * `createRenderPipeline` on someone's device.
 *
 * The runtime reflector the graph executor builds its layouts with
 * (`bindingReflection.ts`) is held to `wgsl_reflect` over the same corpus.
 *
 * With `SHADER_DUMP_DIR` set, the corpus is also written out — one file per
 * distinct module — for `scripts/validate-shaders.mjs` to run through
 * `naga` (WGSL) and `glslangValidator` (GLSL): `npm run shaders:validate`.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResourceType, WgslReflect, type VariableInfo } from 'wgsl_reflect';
import { reflectBindings, type ReflectedResource } from './bindingReflection';
import { buildShaderCorpus } from './__fixtures__/shaderCorpus';
import type { RecordedPipeline } from './__fixtures__/recordingDevice';

const STAGE_BITS = { vertex: 1, fragment: 2, compute: 4 } as const;

/** A binding reduced to what layout and shader must agree on. */
type Shape = string;

function describeTexture(sampleType: string, view: string, multisampled: boolean): Shape {
  return `texture ${sampleType} ${view}${multisampled ? ' ms' : ''}`;
}

/** What `wgsl_reflect` says a declaration is. */
function shapeFromWgslReflect(variable: VariableInfo): Shape {
  const typeName = variable.type.name;
  switch (variable.resourceType) {
    case ResourceType.Uniform:
      return 'buffer uniform';
    case ResourceType.Storage:
      return variable.access === 'read_write' ? 'buffer storage' : 'buffer read-only-storage';
    case ResourceType.Sampler:
      return typeName === 'sampler_comparison' ? 'sampler comparison' : 'sampler filtering';
    case ResourceType.StorageTexture: {
      const view = typeName.replace('texture_storage_', '').replace('_', '-');
      const access = { read: 'read-only', write: 'write-only', read_write: 'read-write' }[variable.access] ?? variable.access;
      return `storage ${variable.format?.name} ${access} ${view}`;
    }
    case ResourceType.Texture: {
      if (typeName === 'texture_external') return 'external';
      const multisampled = typeName.includes('multisampled');
      const view = typeName.replace(/^texture_(depth_)?(multisampled_)?/, '').replace('_', '-');
      if (typeName.startsWith('texture_depth')) return describeTexture('depth', view, multisampled);
      const component = variable.format?.name ?? '';
      const sampleType = { f32: 'float', i32: 'sint', u32: 'uint' }[component] ?? component;
      return describeTexture(sampleType, view, multisampled);
    }
    default:
      return `unsupported resource ${variable.resourceType}`;
  }
}

/**
 * What a layout entry commits the binding to. A `float` and an
 * `unfilterable-float` texture are the same declaration (`texture_2d<f32>`);
 * which one a layout picks is intent, so both read as `float` here.
 */
function shapeFromLayout(entry: GPUBindGroupLayoutEntry): Shape {
  if (entry.buffer) return `buffer ${entry.buffer.type ?? 'uniform'}`;
  if (entry.sampler) return entry.sampler.type === 'comparison' ? 'sampler comparison' : 'sampler filtering';
  if (entry.storageTexture) {
    const { format, access = 'write-only', viewDimension = '2d' } = entry.storageTexture;
    return `storage ${format} ${access} ${viewDimension}`;
  }
  if (entry.texture) {
    const { sampleType = 'float', viewDimension = '2d', multisampled = false } = entry.texture;
    return describeTexture(sampleType === 'unfilterable-float' ? 'float' : sampleType, viewDimension, multisampled);
  }
  if (entry.externalTexture) return 'external';
  return 'empty entry';
}

function shapeFromReflector(resource: ReflectedResource): Shape {
  switch (resource.type) {
    case 'buffer':
      return shapeFromLayout({ binding: 0, visibility: 0, buffer: resource.buffer });
    case 'sampler':
      return shapeFromLayout({ binding: 0, visibility: 0, sampler: resource.sampler });
    case 'texture':
      return shapeFromLayout({ binding: 0, visibility: 0, texture: resource.texture });
    case 'storageTexture':
      return shapeFromLayout({ binding: 0, visibility: 0, storageTexture: resource.storageTexture });
    case 'externalTexture':
      return 'external';
  }
}

const reflections = new Map<string, WgslReflect>();
function reflect(code: string): WgslReflect {
  let reflected = reflections.get(code);
  if (!reflected) {
    reflected = new WgslReflect(code);
    reflections.set(code, reflected);
  }
  return reflected;
}

/** `binding → shape` for a module's `@group(0)` declarations. */
function declaredBindings(code: string): Map<number, Shape> {
  const out = new Map<number, Shape>();
  for (const variable of reflect(code).getBindGroups()[0] ?? []) {
    if (variable) out.set(variable.binding, shapeFromWgslReflect(variable));
  }
  return out;
}

/** Bindings the named entry point actually reaches, through any call depth. */
function usedBindings(code: string, stage: keyof typeof STAGE_BITS, entryPoint: string): Set<number> {
  const entry = reflect(code).entry[stage].find((candidate) => candidate.name === entryPoint);
  if (!entry) throw new Error(`no @${stage} entry point "${entryPoint}"`);
  return new Set(entry.resources.filter((resource) => resource.group === 0).map((resource) => resource.binding));
}

/** Every mismatch between one pipeline's layout and its shaders, as readable lines. */
function layoutMismatches(pipeline: RecordedPipeline): string[] {
  const problems: string[] = [];
  if (pipeline.layouts.length !== 1) problems.push(`expected one bind group layout, got ${pipeline.layouts.length}`);
  const layout = new Map([...(pipeline.layouts[0]?.entries ?? [])].map((entry) => [entry.binding, entry]));

  const declared = new Map<number, Shape>();
  const required = new Map<number, number>();
  for (const { stage, code, entryPoint } of pipeline.stages) {
    for (const [binding, shape] of declaredBindings(code)) {
      const previous = declared.get(binding);
      if (previous && previous !== shape) problems.push(`@binding(${binding}) declared as both ${previous} and ${shape}`);
      declared.set(binding, shape);
    }
    for (const binding of usedBindings(code, stage, entryPoint)) {
      required.set(binding, (required.get(binding) ?? 0) | STAGE_BITS[stage]);
    }
  }

  for (const [binding, shape] of declared) {
    const entry = layout.get(binding);
    if (!entry) {
      problems.push(`@binding(${binding}) ${shape}: declared by the shader, missing from the layout`);
      continue;
    }
    const laidOut = shapeFromLayout(entry);
    if (laidOut !== shape) problems.push(`@binding(${binding}): shader declares ${shape}, layout says ${laidOut}`);
    const stages = required.get(binding) ?? 0;
    if ((entry.visibility & stages) !== stages) {
      problems.push(`@binding(${binding}): used by stage bits ${stages}, layout visibility is ${entry.visibility}`);
    }
  }
  for (const binding of layout.keys()) {
    if (!declared.has(binding)) problems.push(`@binding(${binding}): in the layout, declared by no stage`);
  }
  return problems;
}

/** Parsing ~200 modules with a full WGSL parser takes seconds under a loaded suite. */
const PARSE_TIMEOUT = { timeout: 60_000 };

const corpus = buildShaderCorpus();
const allModules = new Map<string, string>(); // code → a unique name: the first context that built it
const takenNames = new Set<string>();
function addModule(code: string, name: string): void {
  if (allModules.has(code)) return;
  let unique = name;
  for (let n = 2; takenNames.has(unique); n += 1) unique = `${name}-${n}`;
  takenNames.add(unique);
  allModules.set(code, unique);
}
for (const pipeline of corpus.pipelines) {
  for (const { stage, code, entryPoint } of pipeline.stages) addModule(code, `${pipeline.context}-${stage}-${entryPoint}`);
}
for (const { name, code } of corpus.looseWgsl) addModule(code, name);

describe('the shader corpus', () => {
  it('covers every builder', () => {
    const contexts = new Set(corpus.pipelines.map((pipeline) => pipeline.context.split('-')[0]));
    expect([...contexts].sort()).toEqual(['chores', 'graph', 'inspect', 'texture']);
    // Every preset at least once, both terms, both presentations.
    for (const marker of ['graph-default-', 'graph-blur-', 'graph-warp-', 'graph-smear-', 'graph-feedback-', 'graph-trails3-', '-motion-', '-still-', '-hdr-extended-']) {
      expect(corpus.pipelines.some((pipeline) => pipeline.context.includes(marker)), marker).toBe(true);
    }
    expect(corpus.glsl.length).toBeGreaterThan(0);
  });
});

describe('every WGSL module the app builds', PARSE_TIMEOUT, () => {
  it('parses under wgsl_reflect', () => {
    const failures: string[] = [];
    for (const [code, name] of allModules) {
      try {
        reflect(code);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('reflects the same bindings with the runtime reflector as with wgsl_reflect', () => {
    const failures: string[] = [];
    for (const [code, name] of allModules) {
      const expected = [...declaredBindings(code)].sort(([a], [b]) => a - b);
      const actual = reflectBindings(code)
        .filter((binding) => binding.group === 0)
        .map((binding) => [binding.binding, shapeFromReflector(binding.resource)] as const)
        .sort(([a], [b]) => a - b);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(`${name}:\n  wgsl_reflect ${JSON.stringify(expected)}\n  reflector    ${JSON.stringify(actual)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('every pipeline layout matches its shaders', PARSE_TIMEOUT, () => {
  const groups = new Map<string, RecordedPipeline[]>();
  for (const pipeline of corpus.pipelines) {
    const family = pipeline.context.split('-')[0]!;
    groups.set(family, [...(groups.get(family) ?? []), pipeline]);
  }

  it.each([...groups.keys()])('%s pipelines', (family) => {
    const failures = groups.get(family)!.flatMap((pipeline) =>
      layoutMismatches(pipeline).map((problem) => `${pipeline.context}: ${problem}`));
    expect(failures).toEqual([]);
  });

  it('catches a drifted layout (the check itself works)', () => {
    const chore = corpus.pipelines.find((pipeline) => pipeline.context === 'chores-motion')!;
    const layout = chore.layouts[0]!;
    const drifted: RecordedPipeline = {
      ...chore,
      layouts: [{ entries: [...layout.entries].map((entry) =>
        entry.binding === 3 ? { ...entry, storageTexture: { ...entry.storageTexture!, format: 'rgba8unorm' } } : entry) }],
    };
    expect(layoutMismatches(drifted)).toEqual([
      '@binding(3): shader declares storage r32float write-only 2d, layout says storage rgba8unorm write-only 2d',
    ]);
    const missing: RecordedPipeline = {
      ...chore,
      layouts: [{ entries: [...layout.entries].filter((entry) => entry.binding !== 5) }],
    };
    expect(layoutMismatches(missing)).toEqual([
      '@binding(5) buffer uniform: declared by the shader, missing from the layout',
    ]);
  });
});

const dumpDir = process.env.SHADER_DUMP_DIR;
describe.runIf(dumpDir)('shader dump', PARSE_TIMEOUT, () => {
  it('writes every distinct module for naga and glslangValidator', () => {
    const dir = resolve(dumpDir!);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const safe = (name: string) => name.replace(/[^\w.-]+/g, '_');
    for (const [code, name] of allModules) writeFileSync(join(dir, `${safe(name)}.wgsl`), code);
    const seen = new Set<string>();
    for (const { name, stage, code } of corpus.glsl) {
      if (seen.has(code)) continue;
      seen.add(code);
      writeFileSync(join(dir, `${safe(name)}.${stage === 'vertex' ? 'vert' : 'frag'}`), code);
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      wgsl: allModules.size,
      glsl: seen.size,
      pipelines: corpus.pipelines.length,
    }, null, 2));
  });
});
