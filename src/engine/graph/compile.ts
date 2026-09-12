import { allocateTextures } from './allocate';
import { backendSupports } from './capabilities';
import { PassGraphError, unsupportedNodeError } from './errors';
import { structuralHash } from './hash';
import { buildLayerSpecs } from './layerSpecs';
import { scheduleGraph } from './schedule';
import { validateGraph, type ValidationResult } from './validate';
import {
  emitBandLayerGlsl,
  emitCoincidenceDecayGlsl,
  emitCompositorGlsl,
  emitLutGlsl,
} from './templates/glsl';
import {
  emitBandLayerWgsl,
  emitBlurWgsl,
  emitCoincidenceDecayWgsl,
  emitColorHelpersWgsl,
  emitCompositorWgsl,
  emitLutWgsl,
  emitWarpWgsl,
} from './templates/wgsl';
import { WGSL_BLEND_HELPERS } from '../shaders/common';
import type {
  CompiledGraph,
  EmittedPass,
  GraphBackend,
  GraphNode,
  PassGraph,
  ScheduledPass,
} from './types';

const cache = new Map<string, CompiledGraph>();
let compileCount = 0;

/**
 * How many times a graph has actually been compiled this session.
 *
 * The cache is keyed on a structural hash, so changing a parameter — opacity,
 * decay duration, a threshold — must leave this counter alone. `?graph=1`
 * publishes it as `window.passGraphCompileCount` so the breadcrumb is
 * observable from an E2E test, not just a unit test.
 */
export function graphCompileCount(): number {
  return compileCount;
}

/** Drop every cached pipeline. Tests use this; the app never needs to. */
export function resetGraphCompileCache(): void {
  cache.clear();
  compileCount = 0;
}

const intParam = (node: GraphNode, name: string, fallback: number): number => {
  const value = node.params[name];
  return typeof value === 'number' ? value : fallback;
};

function emitPass(
  node: GraphNode,
  pass: ScheduledPass,
  backend: GraphBackend,
  layerCount: number,
): EmittedPass {
  const inputCount = pass.inputs.length;
  const base = { nodeId: node.id, kind: node.kind };

  switch (node.kind) {
    case 'source':
    case 'output':
      // Neither owns a shader: a source binds an externally supplied texture and
      // an output names the swapchain the last pass already wrote.
      return { ...base, fragment: '', textureBindings: [] };

    case 'band-layer': {
      const specs = buildLayerSpecs(intParam(node, 'layerCount', layerCount));
      const spec = specs[intParam(node, 'layerIndex', 0)];
      if (!spec) {
        throw new PassGraphError(
          'input-arity',
          `Node '${node.id}' has layerIndex ${intParam(node, 'layerIndex', 0)}, outside a ${specs.length}-layer graph.`,
          node.id,
        );
      }
      const fragment = backend === 'webgpu'
        ? emitBandLayerWgsl(spec, emitColorHelpersWgsl(specs))
        : emitBandLayerGlsl(specs);
      return { ...base, fragment, textureBindings: ['source', 'classMask', 'profileLut'] };
    }

    case 'lut': {
      const rows = intParam(node, 'rows', layerCount);
      const fragment = backend === 'webgpu' ? emitLutWgsl(rows) : emitLutGlsl(rows);
      return { ...base, fragment, textureBindings: ['source', 'lut'] };
    }

    case 'coincidence':
    case 'decay': {
      // The default graph fuses coincidence into decay (one pass stamps and
      // decays), so both kinds emit the same fused source; a coincidence node
      // feeding several decays emits it once and the decays reuse it.
      const inputs = node.kind === 'decay' ? layerCount : inputCount;
      const fragment = backend === 'webgpu'
        ? emitCoincidenceDecayWgsl(inputs)
        : emitCoincidenceDecayGlsl(inputs);
      const bindings = Array.from({ length: inputs }, (_, i) => `layer${i}`);
      return { ...base, fragment, textureBindings: [...bindings, 'previous'] };
    }

    case 'blend': {
      const layerInputs = intParam(node, 'layerInputs', layerCount);
      const fragment = backend === 'webgpu'
        ? emitCompositorWgsl(layerInputs, WGSL_BLEND_HELPERS)
        : emitCompositorGlsl(layerInputs);
      const bindings = Array.from({ length: layerInputs }, (_, i) => `layer${i}`);
      return {
        ...base,
        fragment,
        textureBindings: [...bindings, 'tracerBelow', 'tracerAbove'],
      };
    }

    case 'warp': {
      const mode = node.params.mode === 'feedback' ? 'feedback' : 'affine';
      return { ...base, fragment: emitWarpWgsl(mode), textureBindings: ['source'] };
    }

    case 'blur':
      return {
        ...base,
        fragment: emitBlurWgsl(intParam(node, 'radius', 2)),
        textureBindings: ['source'],
      };
  }
}

/**
 * Compile a graph for one backend: validate → schedule → allocate → emit.
 *
 * Results are memoised on the structural hash, so re-compiling the same
 * topology is free and a parameter change never recreates a pipeline.
 */
export function compileGraph(graph: PassGraph, backend: GraphBackend): CompiledGraph {
  const hash = structuralHash(graph, backend);
  const cached = cache.get(hash);
  if (cached) return cached;

  const validation = validateForBackend(graph, backend);
  const schedule = scheduleGraph(graph, validation);
  const allocation = allocateTextures(schedule);

  const layerCount = graph.nodes.filter((node) => node.kind === 'band-layer').length;
  const emitted = schedule.passes.map((pass) =>
    emitPass(validation.byId.get(pass.nodeId)!, pass, backend, layerCount),
  );

  const compiled: CompiledGraph = {
    backend,
    hash,
    graph,
    passes: schedule.passes,
    allocation,
    emitted,
    layerCount,
  };
  cache.set(hash, compiled);
  compileCount += 1;
  return compiled;
}

/** Validate, then reject any reachable node this backend has no template for. */
function validateForBackend(graph: PassGraph, backend: GraphBackend): ValidationResult {
  const validation = validateGraph(graph);
  for (const node of graph.nodes) {
    if (!validation.reachable.has(node.id)) continue;
    if (!backendSupports(backend, node.kind)) {
      throw unsupportedNodeError(backend, node.kind, node.id);
    }
  }
  return validation;
}
