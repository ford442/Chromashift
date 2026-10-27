// The default graph's accumulator shaders, re-exported under their pre-graph
// path. The renderer draws whatever `compileGraph` emits (graph/templates).
export {
  persistenceFragmentSource,
  persistenceMotionFragmentSource,
} from '../graph/templates/canonicalWgsl';
