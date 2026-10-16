import type { GraphBackend, NodeKind } from './types';

/**
 * What each backend can emit.
 *
 * This is the honest answer to "what does the WebGL diagnostic backend
 * support": exactly the node kinds with a GLSL template. `compileGraph`
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
  // No `warp`, `blur`, `history` or `displace`: the WebGL path is the
  // diagnostic / XR / screenshot backend and has no GLSL template for them.
  // Adding one here means adding the emitter in templates/glsl.ts — nothing
  // else. `history` and `displace` wait for the WebGL executor on purpose: a
  // GLSL template nothing executes would be dead code, and a refusal by name
  // keeps the WebGL backend's own passes (the classic look) on screen. `motion` is fused
  // into `decay`, whose GLSL template has the motion variant.
  webgl: new Set<NodeKind>([
    'source',
    'band-layer',
    'lut',
    'coincidence',
    'motion',
    'decay',
    'blend',
    'output',
  ]),
};

export function backendSupports(backend: GraphBackend, kind: NodeKind): boolean {
  return SUPPORTED[backend].has(kind);
}

export function supportedNodeKinds(backend: GraphBackend): NodeKind[] {
  return [...SUPPORTED[backend]];
}
