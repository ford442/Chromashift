import { CANONICAL_LAYER_COUNT } from '../../graph/layerSpecs';
import { emitCoincidenceDecayGlsl } from '../../graph/templates/glsl';

// The decay-rate exponents are interpolated from the canonical table in
// shared/decay.json (via DECAY_GLSL) so this diagnostic renderer fades tracers
// at the same rate as the WGSL persistence pass — never hand-write them here.
// See math/decay.ts (`effectiveDecay`) and shaders/decayTable.test.ts.
export const PERSISTENCE_FRAGMENT_SOURCE = emitCoincidenceDecayGlsl(CANONICAL_LAYER_COUNT);

/**
 * Motion-aware variant — see `shaders/persistence.ts` for why this is a
 * separate program rather than a branch: with `motionMode: 'off'` the WebGL
 * backend links the program above, unchanged.
 */
export const PERSISTENCE_MOTION_FRAGMENT_SOURCE = emitCoincidenceDecayGlsl(
  CANONICAL_LAYER_COUNT,
  { motion: true },
);
