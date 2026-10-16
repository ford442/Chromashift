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
  BLUR_UNIFORMS,
  DISPLACE_UNIFORMS,
  HISTORY_UNIFORMS,
  LUT_UNIFORMS,
  WARP_UNIFORMS,
  compositorUniformLayout,
  emitBandLayerWgsl,
  emitBlurWgsl,
  emitCoincidenceDecayWgsl,
  emitColorHelpersWgsl,
  emitCompositorWgsl,
  emitDisplaceWgsl,
  emitHistoryTapsWgsl,
  emitLutWgsl,
  emitWarpWgsl,
  persistUniformLayout,
  toHdrPresentWgsl,
} from './templates/wgsl';
import type { UniformLayout } from './templates/uniformLayout';
import type { CanvasPresentation } from '../gpuOptions';
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
  byId: ReadonlyMap<string, GraphNode>,
  canvas: CanvasPresentation | undefined,
): EmittedPass {
  const inputCount = pass.inputs.length;
  const base = { nodeId: node.id, kind: node.kind };
  const webgpu = backend === 'webgpu';
  // The uniform block a WGSL fragment declares; the GLSL emitters bind by name.
  const block = (layout: UniformLayout): UniformLayout | null => (webgpu ? layout : null);

  switch (node.kind) {
    case 'source':
    case 'output':
      // Neither owns a shader: a source binds an externally supplied texture and
      // an output names the swapchain the last pass already wrote.
      return { ...base, fragment: '', textureBindings: [], uniformLayout: null };

    case 'motion':
      // Fused into the `decay` passes that read it (see below), the way the
      // hand encoder's persistence pass carries the temporal term: a stamp the
      // motion field has not weighted yet is never written out on its own.
      return { ...base, fragment: '', textureBindings: ['stamp', 'field'], uniformLayout: null };

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
      const fragment = webgpu
        ? emitBandLayerWgsl(spec, emitColorHelpersWgsl(specs))
        : emitBandLayerGlsl(specs);
      // The band layer reuses the shipped layer pipeline and its two buffers.
      return { ...base, fragment, textureBindings: ['source', 'classMask', 'profileLut'], uniformLayout: null };
    }

    case 'lut': {
      const rows = intParam(node, 'rows', layerCount);
      const fragment = webgpu ? emitLutWgsl(rows) : emitLutGlsl(rows);
      return { ...base, fragment, textureBindings: ['source', 'lut'], uniformLayout: block(LUT_UNIFORMS) };
    }

    case 'coincidence':
    case 'decay': {
      // The default graph fuses coincidence into decay (one pass stamps and
      // decays), so both kinds emit the same fused source; a coincidence node
      // feeding several decays emits it once and the decays reuse it. A decay
      // that reads a `motion` node carries the temporal term too — the motion
      // variant of the same pass, with the field as one more texture.
      const inputs = node.kind === 'decay' ? layerCount : inputCount;
      const motion = node.kind === 'decay' && byId.get(node.inputs[0])?.kind === 'motion';
      const fragment = webgpu
        ? emitCoincidenceDecayWgsl(inputs, { motion })
        : emitCoincidenceDecayGlsl(inputs, { motion });
      const bindings = Array.from({ length: inputs }, (_, i) => `layer${i}`);
      return {
        ...base,
        fragment,
        textureBindings: [...bindings, 'previous', ...(motion ? ['motion'] : [])],
        uniformLayout: block(persistUniformLayout(motion)),
      };
    }

    case 'blend': {
      const layerInputs = intParam(node, 'layerInputs', layerCount);
      let fragment = webgpu
        ? emitCompositorWgsl(layerInputs, WGSL_BLEND_HELPERS)
        : emitCompositorGlsl(layerInputs);
      // Presenting to an `hdr-extended` canvas swaps the clamping OETF for the
      // extended one, text for text — the source the hand encoder's HDR
      // present pass is built from (`toHdrPresentWgsl`), so the SDR emission
      // and its golden are untouched.
      if (canvas === 'hdr-extended') {
        if (!webgpu) {
          throw new PassGraphError(
            'unsupported-node',
            `The webgl backend has no 'hdr-extended' present for node '${node.id}'; it presents SDR only.`,
            node.id,
          );
        }
        fragment = toHdrPresentWgsl(fragment);
      }
      const bindings = Array.from({ length: layerInputs }, (_, i) => `layer${i}`);
      return {
        ...base,
        fragment,
        textureBindings: [...bindings, 'tracerBelow', 'tracerAbove'],
        uniformLayout: block(compositorUniformLayout(layerInputs)),
        ...(canvas ? { presentation: canvas } : {}),
      };
    }

    case 'warp': {
      const mode = node.params.mode === 'feedback' ? 'feedback' : 'affine';
      return { ...base, fragment: emitWarpWgsl(mode), textureBindings: ['source'], uniformLayout: WARP_UNIFORMS };
    }

    case 'blur':
      return {
        ...base,
        fragment: emitBlurWgsl(intParam(node, 'radius', 2)),
        textureBindings: ['source'],
        uniformLayout: BLUR_UNIFORMS,
      };

    case 'history': {
      // The taps half. The write half is a fixed blit the executor owns
      // (`emitHistoryWriteWgsl`), so it is not a second emitted pass.
      const frames = intParam(node, 'frames', 2);
      return {
        ...base,
        fragment: emitHistoryTapsWgsl(frames),
        textureBindings: Array.from({ length: frames }, (_, i) => `ring${i}`),
        uniformLayout: HISTORY_UNIFORMS,
      };
    }

    case 'displace':
      return {
        ...base,
        fragment: emitDisplaceWgsl(node.params.field === 'color' ? 'color' : 'motion'),
        textureBindings: ['source', 'field'],
        uniformLayout: DISPLACE_UNIFORMS,
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
  // The canvas each `output` presents to, by the node it reads: the pass that
  // writes the swapchain encodes for that canvas and targets its format.
  const canvasOf = new Map<string, CanvasPresentation>();
  for (const node of graph.nodes) {
    if (node.kind !== 'output') continue;
    canvasOf.set(node.inputs[0], node.params.presentation === 'hdr-extended' ? 'hdr-extended' : 'sdr');
  }
  const emitted = schedule.passes.map((pass) =>
    emitPass(
      validation.byId.get(pass.nodeId)!,
      pass,
      backend,
      layerCount,
      validation.byId,
      canvasOf.get(pass.nodeId),
    ),
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
