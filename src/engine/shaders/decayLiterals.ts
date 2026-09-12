import { DECAY } from '../math/decay';

type DecayConstantName = keyof typeof DECAY;

/**
 * Decay constants formatted as GPU shader f32 literals (e.g. "1.5"), generated
 * from the canonical table in shared/decay.json so WGSL/GLSL cannot drift from
 * the TS/C++ persistence formula. Same pattern as `bandLiterals.ts`.
 */
export const DECAY_SHADER_FLOAT = Object.fromEntries(
  (Object.entries(DECAY) as [DecayConstantName, number][]).map(([name, value]) => [
    name,
    value.toFixed(1),
  ]),
) as Record<DecayConstantName, string>;

/** WGSL alias — interpolate into WGSL template strings. */
export const DECAY_WGSL = DECAY_SHADER_FLOAT;

/** GLSL alias — interpolate into GLSL template strings. */
export const DECAY_GLSL = DECAY_SHADER_FLOAT;
