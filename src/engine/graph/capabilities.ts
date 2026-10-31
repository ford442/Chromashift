import { PassGraphError } from './errors';
import type { GraphBackend, GraphNode, NodeKind } from './types';

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

/**
 * What a WebGPU device may withhold that a graph's pipelines could need
 * (#228). A core device grants the first three. A compatibility-mode device
 * (the GL ES / D3D11-class adapter `requestAdapter({ featureLevel:
 * 'compatibility' })` returns) withholds them. The last two are optional at
 * either level.
 *
 * - `independent-blend`: a blend state or write mask that differs between a
 *   pass's color attachments.
 * - `depth-texture-load`: `textureLoad` of a depth texture.
 * - `fragment-storage`: a storage buffer or texture in a fragment shader.
 * - `r8uint-storage`: `r8uint` storage textures (`texture-formats-tier1`).
 * - `hdr-canvas`: an `rgba16float` canvas with `extended` tone mapping.
 */
export type DeviceCapability =
  | 'independent-blend'
  | 'depth-texture-load'
  | 'fragment-storage'
  | 'r8uint-storage'
  | 'hdr-canvas';

/**
 * What each node kind's WebGPU program needs from the device beyond
 * compatibility mode's baseline. It is empty for every kind. The audit
 * (docs/gpu-bootstrap.md § Compatibility mode) found every color target with
 * the default blend and write mask, no depth textures, and storage bindings
 * only in the compute kernels. Dawn's compatibility validation agrees for
 * every shape at every layer count. A template that comes to need one lists
 * it here, and a device without it refuses the graph by name instead of
 * failing pipeline validation. `hdr-canvas` is a param's need, not a kind's
 * (an `hdr-extended` output).
 */
const WEBGPU_NEEDS: Record<NodeKind, readonly DeviceCapability[]> = {
  source: [],
  'band-layer': [],
  lut: [],
  coincidence: [],
  motion: [],
  decay: [],
  blend: [],
  warp: [],
  blur: [],
  history: [],
  displace: [],
  output: [],
};

export interface WebGpuDeviceCapabilities {
  featureLevel: 'core' | 'compatibility';
  granted: ReadonlySet<DeviceCapability>;
  /** Every pooled target and every export sizes by the frame; past this the device refuses the texture. */
  maxTextureDimension2D: number;
}

/** What `device` grants, from its level, features and limits and the canvas's HDR probe. */
export function webGpuDeviceCapabilities(device: {
  featureLevel: 'core' | 'compatibility';
  features: ReadonlySet<string>;
  limits: Pick<GPUSupportedLimits, 'maxTextureDimension2D'>
    & Partial<Pick<GPUSupportedLimits, 'maxStorageBuffersInFragmentStage' | 'maxStorageTexturesInFragmentStage'>>;
  hdrCanvas: boolean;
}): WebGpuDeviceCapabilities {
  const core = device.featureLevel === 'core';
  const granted = new Set<DeviceCapability>();
  if (core) {
    granted.add('independent-blend');
    granted.add('depth-texture-load');
  }
  // Compatibility mode may still grant fragment storage through its limits
  // (Dawn does, over Vulkan); a GL ES backend reports 0.
  const { maxStorageBuffersInFragmentStage, maxStorageTexturesInFragmentStage } = device.limits;
  if (core || ((maxStorageBuffersInFragmentStage ?? 0) > 0 && (maxStorageTexturesInFragmentStage ?? 0) > 0)) {
    granted.add('fragment-storage');
  }
  if (device.features.has('texture-formats-tier1')) granted.add('r8uint-storage');
  if (device.hdrCanvas) granted.add('hdr-canvas');
  return { featureLevel: device.featureLevel, granted, maxTextureDimension2D: device.limits.maxTextureDimension2D };
}

/**
 * The capabilities `graph`'s WebGPU passes need: each node kind's, plus
 * `hdr-canvas` for an `hdr-extended` output.
 */
export function graphCapabilityNeeds(graph: { nodes: readonly GraphNode[] }): DeviceCapability[] {
  const needs = new Set<DeviceCapability>();
  for (const node of graph.nodes) {
    for (const need of WEBGPU_NEEDS[node.kind]) needs.add(need);
    if (node.kind === 'output' && node.params.presentation === 'hdr-extended') needs.add('hdr-canvas');
  }
  return [...needs];
}

/**
 * Refuse `graph` by name when `capabilities` lacks something it needs —
 * an `unsupported-capability` refusal the renderer reports like any other,
 * drawing the default graph instead — or `null` when the device has it all.
 */
export function missingCapabilityError(
  graph: { nodes: readonly GraphNode[] },
  capabilities: WebGpuDeviceCapabilities,
): PassGraphError | null {
  const missing = graphCapabilityNeeds(graph).filter((need) => !capabilities.granted.has(need));
  if (missing.length === 0) return null;
  return new PassGraphError(
    'unsupported-capability',
    `This ${capabilities.featureLevel} device does not grant ${missing.map((need) => `'${need}'`).join(', ')}, `
    + 'which the graph needs.',
  );
}
