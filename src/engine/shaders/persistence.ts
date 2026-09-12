// ─── Persistence fragment shader ─────────────────────────────────────────────────────
//
// Accumulates layer overlaps (collisions) over time with configurable decay.
// When layers overlap, we capture the blended color.
// When they don't overlap, we decay the previous persistence.
//
// Uniforms layout (std140-ish, WGSL explicit offsets):
//   0: decayFactor (f32) – 0.99 = slow fade, 0.5 = fast fade
//   4: colorThresh  (f32) – minimum alpha to consider a "collision"
//   8: stampBoost   (f32) – boost applied only to fresh collision stamps
//  12: tracerMode   (u32)  – 0 = combined colors, 1 = grey highlight
//
// Keep the uniform definition in sync with WebGPURenderer.ts
//
// The decay-rate exponents are interpolated from the canonical table in
// shared/decay.json (via DECAY_WGSL) — never hand-write them here; see
// math/decay.ts and decayTable.test.ts.

import { CANONICAL_LAYER_COUNT } from '../graph/layerSpecs';
import { emitCoincidenceDecayWgsl } from '../graph/templates/wgsl';
import { DECAY_WGSL } from './decayLiterals';

export const persistenceFragmentSource = emitCoincidenceDecayWgsl(CANONICAL_LAYER_COUNT);

// ─── Persistence composite (compute-fed) fragment shader ─────────────────────────────
//
// Lighter counterpart to the fragment shader above, used when the WebGPU
// `coincidence` compute pass (engine/compute/chores/kernels.ts) is available.
// The compute pass does the per-pixel 3-layer overlap detection *once* per
// frame (it does not depend on decay duration, so the fused shader above was
// doing that work twice — once for "below" and once for "above" — for no
// reason). This pass only does the cheap part: sample the stamp it produced
// and decay/select against the previous persistence texture.
//
// `stampTex.b` doubles as the "2+ layers overlapping" flag whenever
// `stampTex.a` is 0 (see the compute shader's doc comment for why that's
// safe) — used here to reproduce the original decay-rate switch.
//
// Uniforms layout:
//   0: decayFactor (f32)
//   4: peakMode    (u32)

export const persistenceCompositeFragmentSource = /* wgsl */ `
@group(0) @binding(0) var stampTex : texture_2d<f32>;
@group(0) @binding(1) var prevTex  : texture_2d<f32>;

struct PersistCompositeUniforms {
  decayFactor : f32,
  peakMode    : u32,
  _pad0       : u32,
  _pad1       : u32,
};
@group(0) @binding(2) var<uniform> pu : PersistCompositeUniforms;

struct FragmentOutputs {
  @location(0) persistence : vec4<f32>,
};

@fragment
fn main(@builtin(position) fragCoord : vec4<f32>) -> FragmentOutputs {
  let coord = vec2<i32>(fragCoord.xy);
  let stamp = textureLoad(stampTex, coord, 0);
  let prev  = textureLoad(prevTex, coord, 0);

  let newColor   = vec4<f32>(stamp.rgb, stamp.a);
  let hadOverlap = stamp.a > 0.5 || stamp.b > 0.5;

  let decayMod = select(${DECAY_WGSL.idleDecayExponent}, ${DECAY_WGSL.overlapDecayExponent}, hadOverlap);
  let effectiveDecay = pow(pu.decayFactor, decayMod);
  var decayed = prev * effectiveDecay;
  if (pu.peakMode == 1u) {
    decayed = vec4<f32>(0.0);
  }

  var out : FragmentOutputs;
  out.persistence = select(decayed, newColor, newColor.a > decayed.a);
  return out;
}
`;
