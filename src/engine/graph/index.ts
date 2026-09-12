/**
 * Pass graph — a declarative IR the renderers compile, instead of a pipeline
 * they hard-code. See docs/PASS_GRAPH.md for the design and the migration plan.
 */
export type {
  AllocationPlan,
  CompiledGraph,
  EdgeType,
  EmittedPass,
  GraphBackend,
  GraphNode,
  NodeKind,
  NodeKindSpec,
  ParamValue,
  PassGraph,
  PoolSlot,
  ResolutionClass,
  ScheduledPass,
  TextureLifetime,
} from './types';
export { NODE_KINDS, isKnownNodeKind, nodeKindSpec } from './nodeKinds';
export { PassGraphError, type GraphErrorCode } from './errors';
export { validateGraph, type FeedbackEdge, type ValidationResult } from './validate';
export { passOrder, scheduleGraph, type Schedule } from './schedule';
export {
  EXTERNAL_SLOT,
  SWAPCHAIN_SLOT,
  allocateTextures,
  estimateVram,
  sharedSlots,
} from './allocate';
export { structuralHash, structuralKey } from './hash';
export { backendSupports, supportedNodeKinds } from './capabilities';
export { compileGraph, graphCompileCount, resetGraphCompileCache } from './compile';
export { DEFAULT_GRAPH_IDS, DEFAULT_LAYER_COUNT, buildDefaultGraph } from './defaultGraph';
export {
  CANONICAL_LAYER_COUNT,
  CANONICAL_LAYER_SPECS,
  buildLayerSpecs,
  type LayerSpec,
} from './layerSpecs';
export {
  activatePassGraph,
  passGraphRequested,
  setStoredPassGraphPreference,
} from './gate';
export { normaliseShaderSource } from './shaderText';
