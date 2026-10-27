import type { GraphBackend, NodeKind } from './types';

/**
 * What each backend can emit.
 *
 * This is the honest answer to "what does the WebGL diagnostic backend
 * support": exactly the node kinds with a GLSL template and an executor that
 * draws them. `compileGraph`
 * consults this table *before* allocating anything, so an unsupported node is a
 * named compile error rather than a silent approximation at runtime.
 */
const SUPPORTED: Record<GraphBackend, ReadonlySet<NodeKind>> = {
  webgpu: new Set<NodeKind>([
    'source',
    'band-layer',
    'lut',
    'coincidence',
    'motion',
    'decay',
    'blend',
    'warp',
    'blur',
    'history',
    'displace',
    'output',
  ]),
  // Every kind, now that each has a GLSL template and the WebGL executor runs
  // them (`templates/glsl.ts`, `exec/WebGLGraphExecutor.ts`). A kind added
  // without its GLSL emitter stays off this list, and a graph reaching it is
  // an `unsupported-node` refusal naming it. `motion` is fused into `decay`,
  // whose GLSL template has the motion variant. What the backend still
  // refuses by name is a *param*, not a kind: an `hdr-extended` output.
  webgl: new Set<NodeKind>([
    'source',
    'band-layer',
    'lut',
    'coincidence',
    'motion',
    'decay',
    'blend',
    'warp',
    'blur',
    'history',
    'displace',
    'output',
  ]),
};

export function backendSupports(backend: GraphBackend, kind: NodeKind): boolean {
  return SUPPORTED[backend].has(kind);
}

export function supportedNodeKinds(backend: GraphBackend): NodeKind[] {
  return [...SUPPORTED[backend]];
}
