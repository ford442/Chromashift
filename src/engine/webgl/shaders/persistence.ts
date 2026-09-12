import { DECAY_GLSL } from '../../shaders/decayLiterals';

// The decay-rate exponents are interpolated from the canonical table in
// shared/decay.json (via DECAY_GLSL) so this diagnostic renderer fades tracers
// at the same rate as the WGSL persistence pass — never hand-write them here.
// See math/decay.ts (`effectiveDecay`) and shaders/decayTable.test.ts.
export const PERSISTENCE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_layer0;
uniform sampler2D u_layer1;
uniform sampler2D u_layer2;
uniform sampler2D u_previous;
uniform float u_decay;
uniform float u_stampBoost;
uniform int u_tracerMode;
uniform int u_peakMode;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec4 c0 = texture(u_layer0, v_uv);
  vec4 c1 = texture(u_layer1, v_uv);
  vec4 c2 = texture(u_layer2, v_uv);
  vec4 prev = texture(u_previous, v_uv);
  // count is an exact sum of step() results (each 0.0 or 1.0), so the integer
  // comparisons below need no epsilon.
  float count = step(0.01, c0.a) + step(0.01, c1.a) + step(0.01, c2.a);
  bool hadOverlap = count > 1.0;
  // Decay modifier: decay faster when actively overlapping, slower otherwise —
  // mirrors the WGSL persistence pass and effectiveDecay() in math/decay.ts.
  float decayMod = hadOverlap ? ${DECAY_GLSL.overlapDecayExponent} : ${DECAY_GLSL.idleDecayExponent};
  float effectiveDecay = pow(u_decay, decayMod);
  // Peak mode discards the decayed history so only fresh collision stamps show,
  // mirroring the WebGPU persistence pass (peakMode -> decayed = 0).
  vec4 decayed = u_peakMode == 1 ? vec4(0.0) : prev * effectiveDecay;
  if (!hadOverlap) {
    outColor = decayed;
    return;
  }
  vec3 combined = (c0.rgb * step(0.01, c0.a) + c1.rgb * step(0.01, c1.a) + c2.rgb * step(0.01, c2.a)) / count;
  float lum = dot(combined, vec3(0.2126, 0.7152, 0.0722));
  vec3 stamped = u_tracerMode == 1 ? vec3(min(lum * u_stampBoost, 1.0)) : min(combined * u_stampBoost, vec3(1.0));
  vec4 fresh = vec4(stamped, count > 2.0 ? 1.0 : 0.72);
  outColor = max(decayed, fresh);
}
`;
