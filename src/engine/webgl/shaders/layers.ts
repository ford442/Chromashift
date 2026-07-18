export const LAYER_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_source;
uniform int u_layerIndex;
uniform float u_avgLuminance;
uniform float u_layerOpacity;
uniform float u_colorMode;
uniform float u_sobelEnabled;
uniform float u_softCropEnabled;

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

vec3 hsl2rgb(float h, float s, float l) {
  vec3 k = vec3(0.0, 8.0, 4.0) + h * 12.0;
  vec3 rgb = clamp(abs(mod(k, 6.0) - 3.0) - 1.0, 0.0, 1.0);
  float a = s * min(l, 1.0 - l);
  return l - a + a * rgb;
}

vec3 bandGradient(float value, float low, float high, float hueLow, float hueHigh, float sat, float lumLow, float lumHigh) {
  float t = clamp((value - low) / max(0.0001, high - low), 0.0, 1.0);
  return hsl2rgb(mix(hueLow, hueHigh, t) / 360.0, sat, mix(lumLow, lumHigh, t));
}

float softThreshold(float v, float edge, float width) {
  return smoothstep(edge - width, edge + width, v);
}

vec4 cropColor(int layer, float bandLum, float soft, float nonAlpha, float darkAlpha) {
  float tw = 2.2;
  if (layer == 0) {
    vec4 grey = vec4(0.753, 0.753, 0.753, nonAlpha);
    vec4 orange = vec4(1.0, 0.627, 0.0, nonAlpha);
    vec4 red = vec4(1.0, 0.0, 0.0, nonAlpha);
    vec4 dark = vec4(0.0, 0.0, 0.0, darkAlpha);
    if (soft < 0.5) {
      if (bandLum >= 229.0) return grey;
      if (bandLum >= 209.0) return orange;
      if (bandLum >= 190.0) return red;
      return dark;
    }
    if (bandLum >= 229.0 - tw) return mix(orange, grey, softThreshold(bandLum, 229.0, tw));
    if (bandLum >= 209.0 - tw) return mix(red, orange, softThreshold(bandLum, 209.0, tw));
    if (bandLum >= 190.0 - tw) return mix(dark, red, softThreshold(bandLum, 190.0, tw));
    return dark;
  }
  if (layer == 1) {
    vec4 violet = vec4(0.502, 0.0, 0.502, nonAlpha);
    vec4 blue = vec4(0.0, 0.0, 0.545, nonAlpha);
    vec4 border = vec4(0.0, 0.0, 1.0, nonAlpha);
    vec4 dark = vec4(0.0, 0.0, 0.0, darkAlpha);
    if (soft < 0.5) {
      if (bandLum >= 177.0 && bandLum < 190.0) return violet;
      if (bandLum >= 161.0 && bandLum < 177.0) return blue;
      if (bandLum >= 158.0 && bandLum < 161.0) return border;
      return dark;
    }
    if (bandLum >= 177.0 - tw) return mix(mix(blue, violet, softThreshold(bandLum, 177.0, tw)), dark, softThreshold(bandLum, 190.0, tw));
    if (bandLum >= 161.0 - tw) return mix(border, blue, softThreshold(bandLum, 177.0, tw));
    if (bandLum >= 158.0 - tw) return mix(dark, border, softThreshold(bandLum, 161.0, tw));
    return dark;
  }
  vec4 green = vec4(0.0, 0.502, 0.0, nonAlpha);
  vec4 yellow = vec4(0.502, 1.0, 0.0, nonAlpha);
  vec4 border = vec4(1.0, 1.0, 0.0, nonAlpha);
  vec4 dark = vec4(0.0, 0.0, 0.0, darkAlpha);
  if (soft < 0.5) {
    if (bandLum >= 145.0 && bandLum < 158.0) return green;
    if (bandLum >= 128.0 && bandLum < 145.0) return yellow;
    if (bandLum >= 125.0 && bandLum < 128.0) return border;
    return dark;
  }
  if (bandLum >= 145.0 - tw) return mix(mix(yellow, green, softThreshold(bandLum, 145.0, tw)), dark, softThreshold(bandLum, 158.0, tw));
  if (bandLum >= 128.0 - tw) return mix(border, yellow, softThreshold(bandLum, 145.0, tw));
  if (bandLum >= 125.0 - tw) return mix(dark, border, softThreshold(bandLum, 128.0, tw));
  return dark;
}

vec4 fixedLayerColor(int layer, float lum) {
  float diff = (u_avgLuminance / 255.0) * 32.0;
  float lightDark = 128.0 + abs(u_avgLuminance - 128.0) / 2.0;
  float rgb = lum + lightDark / 2.0;
  float grey = u_avgLuminance;
  float gDark = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
  if (layer == 0) {
    if (rgb > 229.0) {
      float g = clamp((grey + (rgb - 229.0)) / 255.0, 0.0, 1.0);
      return vec4(g, g, g, 1.0);
    }
    if (rgb > 209.0) return vec4(1.0, (128.0 - diff) / 255.0, 0.0, 1.0);
    if (rgb > 193.0) return vec4((255.0 - diff) / 255.0, 0.0, 0.0, 1.0);
    if (rgb > 190.0) return vec4(1.0, 0.0, 0.0, 1.0);
    if (rgb <= 126.0) return vec4(gDark, gDark, gDark, 1.0);
    return vec4(0.0);
  }
  if (layer == 1) {
    if (rgb > 177.0 && rgb <= 190.0) return vec4((128.0 - diff) / 255.0, 0.0, 1.0, 1.0);
    if (rgb > 161.0 && rgb <= 177.0) return vec4(0.0, 0.0, (255.0 - diff) / 255.0, 1.0);
    if (rgb > 158.0 && rgb <= 161.0) return vec4(0.0, 0.0, 1.0, 1.0);
    if (rgb <= 126.0) return vec4(gDark, gDark, gDark, 1.0);
    return vec4(0.0);
  }
  if (rgb > 145.0 && rgb <= 158.0) return vec4(0.0, (255.0 - diff) / 255.0, 0.0, 1.0);
  if (rgb > 128.0 && rgb <= 145.0) return vec4(1.0, (255.0 - diff) / 255.0, 0.0, 1.0);
  if (rgb > 125.0 && rgb <= 128.0) return vec4(1.0, 1.0, 0.0, 1.0);
  if (rgb <= 126.0) return vec4(gDark, gDark, gDark, 1.0);
  return vec4(0.0);
}

void main() {
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  vec4 sampleColor = texture(u_source, v_uv);
  float rawLum = dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
  float lum = boostedLuminance(v_uv, rawLum);

  vec4 result = vec4(0.0);
  if (u_colorMode == 1.0) {
    if (u_layerIndex == 0) {
      if (lum > 229.0) result = vec4(bandGradient(lum, 229.0, 255.0, 45.0, 60.0, 0.3, 0.80, 1.0), 1.0);
      else if (lum > 209.0) result = vec4(bandGradient(lum, 209.0, 229.0, 10.0, 40.0, 1.0, 0.50, 0.65), 1.0);
      else if (lum > 190.0) result = vec4(bandGradient(lum, 190.0, 209.0, 0.0, 10.0, 1.0, 0.40, 0.55), 1.0);
    } else if (u_layerIndex == 1) {
      if (lum > 177.0 && lum <= 190.0) result = vec4(bandGradient(lum, 177.0, 190.0, 255.0, 290.0, 1.0, 0.40, 0.55), 1.0);
      else if (lum > 158.0 && lum <= 177.0) result = vec4(bandGradient(lum, 158.0, 177.0, 220.0, 255.0, 1.0, 0.38, 0.50), 1.0);
    } else {
      if (lum > 145.0 && lum <= 158.0) result = vec4(bandGradient(lum, 145.0, 158.0, 90.0, 130.0, 1.0, 0.38, 0.50), 1.0);
      else if (lum > 125.0 && lum <= 145.0) result = vec4(bandGradient(lum, 125.0, 145.0, 50.0, 90.0, 1.0, 0.40, 0.52), 1.0);
    }
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
