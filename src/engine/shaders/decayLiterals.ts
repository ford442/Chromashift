import { DECAY } from '../math/decay';

type DecayConstantName = keyof typeof DECAY;

/**
 * Format a canonical constant as a GPU shader f32 literal.
 *
 * Preserves the value exactly — `0.05` must not become `0.1` — and appends
 * `.0` only to integers, which WGSL and GLSL both need to type the literal as
 * `f32` rather than an integer. `scripts/codegen-decay.mjs` applies the same
 * rule when it emits `cpp/decay_table.h`, so the shader and C++ literals stay
 * equal to each other *and* to the TS value.
 */
export function shaderFloat(value: number): string {
  const literal = String(value);
  return Number.isInteger(value) && !/[.eE]/.test(literal) ? `${literal}.0` : literal;
}

/**
 * Decay constants formatted as GPU shader f32 literals (e.g. "1.5"), generated
 * from the canonical table in shared/decay.json so WGSL/GLSL cannot drift from
 * the TS/C++ persistence formula. Same pattern as `bandLiterals.ts`.
 */
export const DECAY_SHADER_FLOAT = Object.fromEntries(
  (Object.entries(DECAY) as [DecayConstantName, number][]).map(([name, value]) => [
    name,
    shaderFloat(value),
  ]),
) as Record<DecayConstantName, string>;

/** WGSL alias — interpolate into WGSL template strings. */
export const DECAY_WGSL = DECAY_SHADER_FLOAT;

/** GLSL alias — interpolate into GLSL template strings. */
export const DECAY_GLSL = DECAY_SHADER_FLOAT;
