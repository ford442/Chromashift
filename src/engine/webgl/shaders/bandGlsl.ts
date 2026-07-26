import { BAND_GLSL, DARK_BAND_RGB_MAX } from '../../shaders/bandLiterals';

const B = BAND_GLSL;

/** Shared GLSL band-colour helpers (crop, fixed CR0P, gradients). */
export const GLSL_BAND_COLOR_HELPERS = `
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
      if (bandLum >= ${B.greyHighlight}) return grey;
      if (bandLum >= ${B.orange}) return orange;
      if (bandLum >= ${B.borderRed}) return red;
      return dark;
    }
    if (bandLum >= ${B.greyHighlight} - tw) return mix(orange, grey, softThreshold(bandLum, ${B.greyHighlight}, tw));
    if (bandLum >= ${B.orange} - tw) return mix(red, orange, softThreshold(bandLum, ${B.orange}, tw));
    if (bandLum >= ${B.borderRed} - tw) return mix(dark, red, softThreshold(bandLum, ${B.borderRed}, tw));
    return dark;
  }
  if (layer == 1) {
    vec4 violet = vec4(0.502, 0.0, 0.502, nonAlpha);
    vec4 blue = vec4(0.0, 0.0, 0.545, nonAlpha);
    vec4 border = vec4(0.0, 0.0, 1.0, nonAlpha);
    vec4 dark = vec4(0.0, 0.0, 0.0, darkAlpha);
    if (soft < 0.5) {
      if (bandLum >= ${B.violet} && bandLum < ${B.borderRed}) return violet;
      if (bandLum >= ${B.blue} && bandLum < ${B.violet}) return blue;
      if (bandLum >= ${B.borderBlue} && bandLum < ${B.blue}) return border;
      return dark;
    }
    if (bandLum >= ${B.violet} - tw) return mix(mix(blue, violet, softThreshold(bandLum, ${B.violet}, tw)), dark, softThreshold(bandLum, ${B.borderRed}, tw));
    if (bandLum >= ${B.blue} - tw) return mix(border, blue, softThreshold(bandLum, ${B.violet}, tw));
    if (bandLum >= ${B.borderBlue} - tw) return mix(dark, border, softThreshold(bandLum, ${B.blue}, tw));
    return dark;
  }
  vec4 green = vec4(0.0, 0.502, 0.0, nonAlpha);
  vec4 yellow = vec4(0.502, 1.0, 0.0, nonAlpha);
  vec4 border = vec4(1.0, 1.0, 0.0, nonAlpha);
  vec4 dark = vec4(0.0, 0.0, 0.0, darkAlpha);
  if (soft < 0.5) {
    if (bandLum >= ${B.green} && bandLum < ${B.borderBlue}) return green;
    if (bandLum >= ${B.yellow} && bandLum < ${B.green}) return yellow;
    if (bandLum >= ${B.borderYellow} && bandLum < ${B.yellow}) return border;
    return dark;
  }
  if (bandLum >= ${B.green} - tw) return mix(mix(yellow, green, softThreshold(bandLum, ${B.green}, tw)), dark, softThreshold(bandLum, ${B.borderBlue}, tw));
  if (bandLum >= ${B.yellow} - tw) return mix(border, yellow, softThreshold(bandLum, ${B.green}, tw));
  if (bandLum >= ${B.borderYellow} - tw) return mix(dark, border, softThreshold(bandLum, ${B.yellow}, tw));
  return dark;
}

vec4 fixedLayerColor(int layer, float lum) {
  float diff = (u_avgLuminance / 255.0) * 32.0;
  float lightDark = 128.0 + abs(u_avgLuminance - 128.0) / 2.0;
  float rgb = lum + lightDark / 2.0;
  float grey = u_avgLuminance;
  float gDark = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
  if (layer == 0) {
    if (rgb > ${B.greyHighlight}) {
      float g = clamp((grey + (rgb - ${B.greyHighlight})) / 255.0, 0.0, 1.0);
      return vec4(g, g, g, 1.0);
    }
    if (rgb > ${B.orange}) return vec4(1.0, (128.0 - diff) / 255.0, 0.0, 1.0);
    if (rgb > ${B.red}) return vec4((255.0 - diff) / 255.0, 0.0, 0.0, 1.0);
    if (rgb > ${B.borderRed}) return vec4(1.0, 0.0, 0.0, 1.0);
    if (rgb <= ${DARK_BAND_RGB_MAX}) return vec4(gDark, gDark, gDark, 1.0);
    return vec4(0.0);
  }
  if (layer == 1) {
    if (rgb > ${B.violet} && rgb <= ${B.borderRed}) return vec4((128.0 - diff) / 255.0, 0.0, 1.0, 1.0);
    if (rgb > ${B.blue} && rgb <= ${B.violet}) return vec4(0.0, 0.0, (255.0 - diff) / 255.0, 1.0);
    if (rgb > ${B.borderBlue} && rgb <= ${B.blue}) return vec4(0.0, 0.0, 1.0, 1.0);
    if (rgb <= ${DARK_BAND_RGB_MAX}) return vec4(gDark, gDark, gDark, 1.0);
    return vec4(0.0);
  }
  if (rgb > ${B.green} && rgb <= ${B.borderBlue}) return vec4(0.0, (255.0 - diff) / 255.0, 0.0, 1.0);
  if (rgb > ${B.yellow} && rgb <= ${B.green}) return vec4(1.0, (255.0 - diff) / 255.0, 0.0, 1.0);
  if (rgb > ${B.borderYellow} && rgb <= ${B.yellow}) return vec4(1.0, 1.0, 0.0, 1.0);
  if (rgb <= ${DARK_BAND_RGB_MAX}) return vec4(gDark, gDark, gDark, 1.0);
  return vec4(0.0);
}
`;

/** Chromashift gradient mode colour selection (shared by layer + debug shaders). */
export const GLSL_GRADIENT_LAYER_BRANCH = `
    if (u_layerIndex == 0) {
      if (lum > ${B.greyHighlight}) result = vec4(bandGradient(lum, ${B.greyHighlight}, 255.0, 45.0, 60.0, 0.3, 0.80, 1.0), 1.0);
      else if (lum > ${B.orange}) result = vec4(bandGradient(lum, ${B.orange}, ${B.greyHighlight}, 10.0, 40.0, 1.0, 0.50, 0.65), 1.0);
      else if (lum > ${B.borderRed}) result = vec4(bandGradient(lum, ${B.borderRed}, ${B.orange}, 0.0, 10.0, 1.0, 0.40, 0.55), 1.0);
    } else if (u_layerIndex == 1) {
      if (lum > ${B.violet} && lum <= ${B.borderRed}) result = vec4(bandGradient(lum, ${B.violet}, ${B.borderRed}, 255.0, 290.0, 1.0, 0.40, 0.55), 1.0);
      else if (lum > ${B.borderBlue} && lum <= ${B.violet}) result = vec4(bandGradient(lum, ${B.borderBlue}, ${B.violet}, 220.0, 255.0, 1.0, 0.38, 0.50), 1.0);
    } else {
      if (lum > ${B.green} && lum <= ${B.borderBlue}) result = vec4(bandGradient(lum, ${B.green}, ${B.borderBlue}, 90.0, 130.0, 1.0, 0.38, 0.50), 1.0);
      else if (lum > ${B.borderYellow} && lum <= ${B.green}) result = vec4(bandGradient(lum, ${B.borderYellow}, ${B.green}, 50.0, 90.0, 1.0, 0.40, 0.52), 1.0);
    }
`;

/** Layer-isolation debug wrapper around shared band colour paths. */
export const GLSL_COMPUTE_LAYER_COLOR_FN = `
vec4 computeLayerColor(float lum) {
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
  return result;
}
`;
