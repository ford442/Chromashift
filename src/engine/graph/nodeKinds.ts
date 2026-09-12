import type { NodeKind, NodeKindSpec } from './types';

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
    structuralParams: [],
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
