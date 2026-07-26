import {
  GLSL_BAND_COLOR_HELPERS,
  GLSL_COMPUTE_LAYER_COLOR_FN,
} from './bandGlsl';

/** Shared luminance helpers for debug fragment shaders. */
const LUMINANCE_HELPERS = `
float luminanceAt(vec2 uv) {
  vec3 c = texture(u_source, uv).rgb;
  return dot(c, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
}

float boostedLuminance(vec2 uv, float baseLum) {
  if (u_sobelEnabled < 0.5) return baseLum;
  vec2 texel = 1.0 / vec2(textureSize(u_source, 0));
  float tl = luminanceAt(uv + texel * vec2(-1.0, -1.0));
  float tc = luminanceAt(uv + texel * vec2(0.0, -1.0));
  float tr = luminanceAt(uv + texel * vec2(1.0, -1.0));
  float ml = luminanceAt(uv + texel * vec2(-1.0, 0.0));
  float mr = luminanceAt(uv + texel * vec2(1.0, 0.0));
  float bl = luminanceAt(uv + texel * vec2(-1.0, 1.0));
  float bc = luminanceAt(uv + texel * vec2(0.0, 1.0));
  float br = luminanceAt(uv + texel * vec2(1.0, 1.0));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  return clamp(baseLum + 16.0 * length(vec2(gx, gy)), 0.0, 255.0);
}
`;

const DEBUG_HEADER = `#version 300 es
precision highp float;

uniform sampler2D u_source;
uniform int u_layerIndex;
uniform float u_avgLuminance;
uniform float u_colorMode;
uniform float u_sobelEnabled;
uniform float u_softCropEnabled;

in vec2 v_uv;
in vec2 v_baseUv;
out vec4 outColor;
`;

export const LUMINANCE_DEBUG_FRAGMENT = `${DEBUG_HEADER}
${LUMINANCE_HELPERS}

void main() {
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  vec4 sampleColor = texture(u_source, v_uv);
  float rawLum = dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
  float lum = boostedLuminance(v_uv, rawLum);
  float l = lum / 255.0;
  outColor = vec4(l, l, l, 1.0);
}
`;

export const UV_GRID_DEBUG_FRAGMENT = `${DEBUG_HEADER}

void main() {
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  vec2 grid = step(vec2(0.965), fract(v_uv * 12.0));
  float line = max(grid.x, grid.y);
  outColor = vec4(v_uv, line, 1.0);
}
`;

export const LAYER_ISOLATION_DEBUG_FRAGMENT = `${DEBUG_HEADER}
${LUMINANCE_HELPERS}
${GLSL_BAND_COLOR_HELPERS}
${GLSL_COMPUTE_LAYER_COLOR_FN}

void main() {
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  vec4 sampleColor = texture(u_source, v_uv);
  float rawLum = dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
  float lum = boostedLuminance(v_uv, rawLum);
  vec4 result = computeLayerColor(lum);
  outColor = result.a > 0.0 ? vec4(result.rgb, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
}
`;
