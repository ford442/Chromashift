/**
 * Pass graph — a declarative IR the renderers compile, instead of a pipeline
 * they hard-code. See docs/PASS_GRAPH.md for the design and the migration plan.
 */
export { PassGraphError } from './errors';
export { validateGraph } from './validate';
export { passOrder, scheduleGraph } from './schedule';
export {
  allocateTextures,
  estimateVram,
  ringTexturesByResolution,
  sharedSlots,
} from './allocate';
export { structuralHash, structuralKey } from './hash';
export { supportedNodeKinds } from './capabilities';
export { compileGraph, graphCompileCount, resetGraphCompileCache } from './compile';
export { DEFAULT_GRAPH_IDS, DEFAULT_LAYER_COUNT, buildDefaultGraph } from './defaultGraph';
export {
  buildGraphPreset,
  parsePassGraphJson,
  type GraphPresetName,
} from './altGraphs';
// The executors are deliberately *not* re-exported here. Both renderers import
// this barrel, and a value export would drag the WebGPU encode path into the
// WebGL diagnostic chunk (or the reverse). Import `./exec/WebGpuGraphExecutor`
// or `./exec/WebGLGraphExecutor` directly instead.
export {
  MAX_LAYER_COUNT,
  assertLayerCount,
  buildLayerSpecs,
} from './layerSpecs';
export {
  activatePassGraph,
  passGraphRefusal,
  passGraphSelection,
  publishGraphExecutorBreadcrumbs,
  publishGraphVariant,
  publishSlotExecuting,
  setStoredPassGraphPreference,
} from './gate';
export {
  applyGraphVariant,
  graphVariantKey,
  presetGraphSource,
  type GraphVariant,
  type PassGraphSource,
} from './variants';
