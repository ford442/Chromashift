
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
