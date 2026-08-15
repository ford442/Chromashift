import {
  GLSL_BAND_COLOR_HELPERS,
  GLSL_GRADIENT_LAYER_BRANCH,
} from './bandGlsl';

export const LAYER_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_source;
uniform int u_layerIndex;
uniform float u_avgLuminance;
uniform float u_layerOpacity;
uniform float u_colorMode;
uniform float u_sobelEnabled;
uniform float u_softCropEnabled;
uniform sampler2D u_profileLut;
uniform float u_profileMode;
uniform float u_profileLightDark;

in vec2 v_uv;
in vec2 v_baseUv;
out vec4 outColor;

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

${GLSL_BAND_COLOR_HELPERS}

/**
 * Named colour profile lookup (docs/COLOR_PROFILES.md) — column = preprocessed
 * luminance bucket, row = layer index. ceil() matches the CPU band rule
 * (value > min && value <= max) exactly for integer band bounds.
 */
vec4 profileColor(float lum) {
  float lift = u_profileLightDark > 0.5
    ? (128.0 + abs(u_avgLuminance - 128.0) * 0.5) * 0.5
    : 0.0;
  float value = clamp(lum + lift, 0.0, 255.0);
  int col = int(clamp(ceil(value), 0.0, 255.0));
  return texelFetch(u_profileLut, ivec2(col, u_layerIndex), 0);
}

void main() {
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  vec4 sampleColor = texture(u_source, v_uv);
  float rawLum = dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
  float lum = boostedLuminance(v_uv, rawLum);

  if (u_profileMode > 0.5) {
    vec4 profile = profileColor(lum);
    outColor = vec4(profile.rgb, profile.a * u_layerOpacity);
    return;
  }

  vec4 result = vec4(0.0);
  if (u_colorMode == 1.0) {
${GLSL_GRADIENT_LAYER_BRANCH}
  } else if (u_colorMode >= 1.5) {
    float adjusted = lum + (128.0 + abs(u_avgLuminance - 128.0) * 0.5) * 0.5;
    bool isNunif2 = u_colorMode > 2.5;
    float bandLum = isNunif2 ? adjusted : lum;
    float nonAlpha = isNunif2 && u_layerIndex == 0 ? 0.5 : isNunif2 ? 0.777 : 1.0;
    float darkAlpha = isNunif2 ? 0.1 : 0.0;
    result = cropColor(u_layerIndex, bandLum, u_softCropEnabled, nonAlpha, darkAlpha);
  } else {
    result = fixedLayerColor(u_layerIndex, lum);
  }

  outColor = vec4(result.rgb, result.a * u_layerOpacity);
}
`;
