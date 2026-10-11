import type { GraphNode, NodeKind, NodeKindSpec, ResolutionClass } from './types';

/**
 * The node-kind registry. Adding an effect means adding an entry here plus a
 * template in `templates/` — not editing a renderer.
 */
const SPECS: Record<NodeKind, NodeKindSpec> = {
  source: {
    kind: 'source',
    minInputs: 0,
    maxInputs: 0,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'source',
    pingPong: false,
    // `role` picks which external texture the executor binds ('image' or
    // 'motion-field'). It changes no shader text, but it is structural anyway:
    // the compile cache returns the first graph of a topology, so a value
    // param read at bind time could be a stale one from an earlier graph.
    structuralParams: ['role'],
  },
  'band-layer': {
    kind: 'band-layer',
    minInputs: 1,
    maxInputs: 1,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'layer',
    pingPong: false,
    // `layerIndex` selects the band table row baked into the shader; `layerCount`
    // sizes the profile LUT rows. Both change code, so both are structural.
    structuralParams: ['layerIndex', 'layerCount'],
  },
  lut: {
    kind: 'lut',
    minInputs: 1,
    maxInputs: 1,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'layer',
    pingPong: false,
    structuralParams: ['rows'],
  },
  coincidence: {
    kind: 'coincidence',
    // One input is legal and degenerate: nothing can overlap with itself, so
    // the emitted shader's `>= minOverlap` branch never fires. That is what a
    // single-layer graph (a pure LUT grade) wants.
    minInputs: 1,
    maxInputs: Number.POSITIVE_INFINITY,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'tracer',
    pingPong: false,
    // Input count is baked into the unrolled overlap counter.
    structuralParams: ['minOverlap', 'emitDiagnostic'],
  },
  decay: {
    kind: 'decay',
    minInputs: 1,
    maxInputs: 1,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'tracer',
    pingPong: true,
    structuralParams: [],
  },
  blend: {
    kind: 'blend',
    minInputs: 2,
    maxInputs: Number.POSITIVE_INFINITY,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'output',
    pingPong: false,
    structuralParams: ['layerInputs', 'tracerInputs'],
  },
  warp: {
    kind: 'warp',
    minInputs: 1,
    maxInputs: 1,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'layer',
    pingPong: false,
    structuralParams: ['mode'],
  },
  blur: {
    kind: 'blur',
    minInputs: 1,
    maxInputs: 1,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'layer',
    pingPong: false,
    structuralParams: ['radius'],
  },
  history: {
    kind: 'history',
    minInputs: 1,
    maxInputs: 1,
    inputType: 'texture',
    outputType: 'texture',
    // The default; `params.resolution` may say 'tracer' (see `nodeResolution`).
    resolution: 'layer',
    // Not ping-pong: the ring is read *after* this frame's write, so its output
    // is not a previous-frame value a cycle could close on.
    pingPong: false,
    // `frames` sizes the ring and unrolls the tap loop; `resolution` sizes the
    // ring's textures. `mode`, `delay` and `falloff` are tap weights — uniforms.
    structuralParams: ['frames', 'resolution'],
  },
  displace: {
    kind: 'displace',
    // [source, field]
    minInputs: 2,
    maxInputs: 2,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'layer',
    pingPong: false,
    // `field` picks the channels and units the emitted shader reads.
    structuralParams: ['field'],
  },
  output: {
    kind: 'output',
    minInputs: 1,
    maxInputs: 1,
    inputType: 'texture',
    outputType: null,
    resolution: 'output',
    pingPong: false,
    structuralParams: [],
  },
};

export const NODE_KINDS = Object.keys(SPECS) as NodeKind[];

export function nodeKindSpec(kind: NodeKind): NodeKindSpec {
  return SPECS[kind];
}

export function isKnownNodeKind(kind: string): kind is NodeKind {
  return Object.prototype.hasOwnProperty.call(SPECS, kind);
}

/** Ring-length bounds for `history` — the cap is what keeps its VRAM bounded. */
export const HISTORY_MIN_FRAMES = 2;
export const HISTORY_MAX_FRAMES = 8;

/**
 * Resolution class of one node's render target.
 *
 * Every kind has a fixed class except `history`, which runs at `layer` scale by
 * default or `tracer` scale when asked. Its ring and its output share that one
 * class — they are never mixed.
 */
export function nodeResolution(node: GraphNode): ResolutionClass {
  if (node.kind === 'history' && node.params.resolution === 'tracer') return 'tracer';
  return SPECS[node.kind].resolution;
}
