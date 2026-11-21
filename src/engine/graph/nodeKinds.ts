import type { GraphNode, NodeKind, NodeKindSpec, ResolutionClass } from './types';

/**
 * One particle, as `emit` appends it and `advect` moves it: `pos` and `vel`
 * (UV, UV per second), the birth colour packed `unorm8x4`, `age` and `life`
 * (seconds; `life` 0 is an empty or dead slot) and the hashed `seed` it was
 * born with. 32 bytes — `splat` reads the same bytes as instance attributes.
 */
export const PARTICLE_STRIDE = 32;

/**
 * An `append` buffer's control block: the `atomic<u32>` head, then the
 * `dispatchWorkgroupsIndirect` arguments (3 × u32) and the `drawIndirect`
 * arguments (4 × u32) derived from it. 32 bytes.
 */
export const APPEND_CONTROL_BYTES = 32;
/** Byte offset of the `dispatchWorkgroupsIndirect` arguments: just past the head. */
export const APPEND_DISPATCH_ARGS_OFFSET = 4;
/** Byte offset of the `drawIndirect` arguments in the control block. */
export const APPEND_DRAW_ARGS_OFFSET = 16;

/**
 * `emit`'s ring capacity bounds — a structural param, because it sizes the
 * buffer and so caps the chain's VRAM: at the maximum, 262 144 × 32 B = 8 MiB.
 */
export const PARTICLE_CAPACITY_MIN = 64;
export const PARTICLE_CAPACITY_MAX = 262_144;
export const PARTICLE_CAPACITY_DEFAULT = 16_384;

/** Kernel sizes. `emit` tiles the mask in 8×8; `advect` and the args kernel run one particle per lane. */
export const EMIT_WORKGROUP = [8, 8, 1] as const;
export const ADVECT_WORKGROUP = [64, 1, 1] as const;

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
    stage: 'render',
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
    stage: 'render',
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
    stage: 'render',
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
    stage: 'render',
  },
  motion: {
    kind: 'motion',
    // [stamp, field]: the stamp to weight, and a `source` with role
    // 'motion-field' (checked by `validate.ts`). `boost`, `gate` and
    // `direction`, the gain and the decay bias are uniforms read from
    // `RendererState`, so moving between motion modes never recompiles; only
    // switching the term on or off — adding or removing this node — does.
    minInputs: 2,
    maxInputs: 2,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'tracer',
    pingPong: false,
    structuralParams: [],
    stage: 'render',
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
    stage: 'render',
  },
  blend: {
    kind: 'blend',
    minInputs: 2,
    maxInputs: Number.POSITIVE_INFINITY,
    inputType: 'texture',
    outputType: 'texture',
    resolution: 'output',
    pingPong: false,
    // `overlayInputs`: how many trailing extra tracers blend on top, not deepest.
    structuralParams: ['layerInputs', 'tracerInputs', 'overlayInputs'],
    stage: 'render',
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
    stage: 'render',
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
    stage: 'render',
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
    stage: 'render',
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
    stage: 'render',
  },
  emit: {
    kind: 'emit',
    // [mask]: a `coincidence` node — fused, as into a `decay`, so the overlap
    // test runs inline over its band layers — or any texture, read as a
    // spawn mask by its alpha.
    minInputs: 1,
    maxInputs: 1,
    inputType: 'texture',
    outputType: 'buffer',
    resolution: 'layer',
    pingPong: false,
    // `capacity` sizes the ring. `spawnChance`, `lifetime` and `boost` are
    // uniforms, so tuning the emitter never recompiles.
    structuralParams: ['capacity'],
    stage: 'compute',
    workgroup: EMIT_WORKGROUP,
    buffer: {
      owns: true,
      layout: 'append',
      stride: PARTICLE_STRIDE,
      elements: {
        param: 'capacity',
        fallback: PARTICLE_CAPACITY_DEFAULT,
        min: PARTICLE_CAPACITY_MIN,
        max: PARTICLE_CAPACITY_MAX,
      },
      // The particles outlive the frame: the ring is the chain's state.
      persistent: true,
    },
    bufferAccess: 'storage',
  },
  advect: {
    kind: 'advect',
    // [particles, field]: what `emit` appended, and a `source` with role
    // 'motion-field' (checked by `validate.ts`, as for `motion`).
    minInputs: 2,
    maxInputs: 2,
    inputType: 'texture',
    inputTypes: ['buffer', 'texture'],
    outputType: 'buffer',
    resolution: 'layer',
    pingPong: false,
    structuralParams: [],
    stage: 'compute',
    workgroup: ADVECT_WORKGROUP,
    buffer: { owns: false },
    bufferAccess: 'storage',
  },
  splat: {
    kind: 'splat',
    // [particles]: one instanced quad per filled ring slot, drawn indirect.
    minInputs: 1,
    maxInputs: 1,
    inputType: 'buffer',
    outputType: 'texture',
    resolution: 'tracer',
    pingPong: false,
    structuralParams: [],
    stage: 'render',
    // Instance-stepped vertex attributes: no storage binding in a render
    // stage, so a compatibility-mode device draws it too.
    bufferAccess: 'vertex',
  },
  output: {
    kind: 'output',
    minInputs: 1,
    maxInputs: 1,
    inputType: 'texture',
    outputType: null,
    resolution: 'output',
    pingPong: false,
    // `presentation` ('sdr' | 'hdr-extended') is the canvas this output
    // presents to. It picks the OETF the pass writing it emits and that pass's
    // target format, so it is structural.
    structuralParams: ['presentation'],
    stage: 'render',
  },
};

export function nodeKindSpec(kind: NodeKind): NodeKindSpec {
  return SPECS[kind];
}

/** The edge type a node of `spec` expects at input `index`. */
export function inputEdgeType(spec: NodeKindSpec, index: number): NodeKindSpec['inputType'] {
  return spec.inputTypes?.[index] ?? spec.inputType;
}

/**
 * True for a node that takes part in a buffer chain: a compute node, or a
 * render node that reads a buffer. The scheduler hoists these as early as
 * their inputs allow (see `schedule.ts`).
 */
export function isBufferStage(spec: NodeKindSpec): boolean {
  return spec.stage === 'compute' || spec.outputType === 'buffer' || spec.inputType === 'buffer'
    || (spec.inputTypes?.includes('buffer') ?? false);
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
