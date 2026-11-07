import { mat3ToGlsl, type Mat3 } from '../../color/presentation';

/**
 * The WebGL presentation blit for a non-identity matrix. The WebGL compositor
 * writes sRGB-encoded values, so: decode → linear matrix → clip → encode. The
 * matrix literal is emitted from the named constant (`color/presentation.ts`),
 * never written by hand, so it is the WebGPU compositor's matrix exactly.
 */
export function emitPresentBlitGlsl(matrix: Mat3): string {
  return `#version 300 es
precision highp float;

uniform sampler2D u_source;
in vec2 v_uv;
out vec4 outColor;

const mat3 PRESENT_MATRIX = ${mat3ToGlsl(matrix)};

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}

vec3 linearToSrgb(vec3 c) {
  vec3 lin = clamp(c, 0.0, 1.0);
  vec3 lo = lin * 12.92;
  vec3 hi = 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(lin, vec3(0.0031308))));
}

void main() {
  vec4 src = texture(u_source, v_uv);
  outColor = vec4(linearToSrgb(PRESENT_MATRIX * srgbToLinear(src.rgb)), src.a);
}
`;
}
