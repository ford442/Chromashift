
fn hsl2rgb(h: f32, s: f32, l: f32) -> vec3<f32> {
  let a = s * min(l, 1.0 - l);
  let k = vec3<f32>(0.0, 8.0, 4.0) + h * 12.0;
  let rgb = clamp(abs((k % 6.0) - 3.0) - 1.0, vec3<f32>(0.0), vec3<f32>(1.0));
  return l - a + a * rgb;
}

fn band_gradient(
  val       : f32,
  low       : f32,   high      : f32,
  hue_low   : f32,   hue_high  : f32,
  sat       : f32,
  lum_low   : f32,   lum_high  : f32
) -> vec3<f32> {
  let t = clamp((val - low) / (high - low), 0.0, 1.0);
  let hue = mix(hue_low, hue_high, t) / 360.0;
  let lum = mix(lum_low, lum_high, t);
  return hsl2rgb(hue, sat, lum);
}

// Soft threshold helper for smoother colour band transitions.
// Using a 2.5-unit transition width reduces hard aliasing and posterisation
// on smooth source gradients while keeping the artistic "cut" character of the
// original cr0p / nunif separation. This is a high-perceived-quality, zero-cost
// improvement (smoothstep is a single ALU op on modern GPUs).
fn softThreshold(v: f32, edge: f32, width: f32) -> f32 {
  return smoothstep(edge - width, edge + width, v);
}

const SOFT_CROP_TW : f32 = 2.2;
const SOBEL_EDGE_BOOST : f32 = 16.0;

fn pixelLuminanceAt(tex: texture_2d<f32>, texSampler: sampler, uv: vec2<f32>) -> f32 {
  let sample = textureSample(tex, texSampler, uv);
  return dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;
}

// Sobel gradient magnitude on BT.709 luminance — boosts edge pixels before band assignment.
fn sobelBoostedLuminance(
  tex: texture_2d<f32>,
  texSampler: sampler,
  uv: vec2<f32>,
  baseLum: f32,
  enabled: f32,
) -> f32 {
  if (enabled < 0.5) { return baseLum; }
  let dims = vec2<f32>(textureDimensions(tex));
  let px = vec2<f32>(1.0 / dims.x, 1.0 / dims.y);
  let tl = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(-px.x, -px.y));
  let tc = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(0.0, -px.y));
  let tr = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(px.x, -px.y));
  let ml = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(-px.x, 0.0));
  let mr = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(px.x, 0.0));
  let bl = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(-px.x, px.y));
  let bc = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(0.0, px.y));
  let br = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(px.x, px.y));
  let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  let mag = length(vec2<f32>(gx, gy));
  return clamp(baseLum + SOBEL_EDGE_BOOST * mag, 0.0, 255.0);
}

fn cropLayer0Color(bandLum: f32, soft: f32, nonAlpha: f32, darkAlpha: f32) -> vec4<f32> {
  let grey = vec4<f32>(0.753, 0.753, 0.753, nonAlpha);
  let orange = vec4<f32>(1.0, 0.627, 0.0, nonAlpha);
  let red = vec4<f32>(1.0, 0.0, 0.0, nonAlpha);
  let dark = vec4<f32>(0.0, 0.0, 0.0, darkAlpha);
  if (soft < 0.5) {
    if (bandLum >= 229.0) { return grey; }
    if (bandLum >= 209.0) { return orange; }
    if (bandLum >= 190.0) { return red; }
    return dark;
  }
  let tw = SOFT_CROP_TW;
  if (bandLum >= 229.0 - tw) {
    return mix(orange, grey, softThreshold(bandLum, 229.0, tw));
  }
  if (bandLum >= 209.0 - tw) {
    return mix(red, orange, softThreshold(bandLum, 209.0, tw));
  }
  if (bandLum >= 190.0 - tw) {
    return mix(dark, red, softThreshold(bandLum, 190.0, tw));
  }
  return dark;
}

fn cropLayer1Color(bandLum: f32, soft: f32, nonAlpha: f32, darkAlpha: f32) -> vec4<f32> {
  let violet = vec4<f32>(0.502, 0.0, 0.502, nonAlpha);
  let blue = vec4<f32>(0.0, 0.0, 0.545, nonAlpha);
  let borderBlue = vec4<f32>(0.0, 0.0, 1.0, nonAlpha);
  let dark = vec4<f32>(0.0, 0.0, 0.0, darkAlpha);
  if (soft < 0.5) {
    if (bandLum >= 177.0 && bandLum < 190.0) { return violet; }
    if (bandLum >= 161.0 && bandLum < 177.0) { return blue; }
    if (bandLum >= 158.0 && bandLum < 161.0) { return borderBlue; }
    return dark;
  }
  let tw = SOFT_CROP_TW;
  if (bandLum >= 177.0 - tw) {
    let inner = mix(blue, violet, softThreshold(bandLum, 177.0, tw));
    return mix(inner, dark, softThreshold(bandLum, 190.0, tw));
  }
  if (bandLum >= 161.0 - tw) {
    return mix(borderBlue, blue, softThreshold(bandLum, 177.0, tw));
  }
  if (bandLum >= 158.0 - tw) {
    return mix(dark, borderBlue, softThreshold(bandLum, 161.0, tw));
  }
  return dark;
}

fn cropLayer2Color(bandLum: f32, soft: f32, nonAlpha: f32, darkAlpha: f32) -> vec4<f32> {
  let green = vec4<f32>(0.0, 0.502, 0.0, nonAlpha);
  let yellow = vec4<f32>(0.502, 1.0, 0.0, nonAlpha);
  let borderYellow = vec4<f32>(1.0, 1.0, 0.0, nonAlpha);
  let dark = vec4<f32>(0.0, 0.0, 0.0, darkAlpha);
  if (soft < 0.5) {
    if (bandLum >= 145.0 && bandLum < 158.0) { return green; }
    if (bandLum >= 128.0 && bandLum < 145.0) { return yellow; }
    if (bandLum >= 125.0 && bandLum < 128.0) { return borderYellow; }
    return dark;
  }
  let tw = SOFT_CROP_TW;
  if (bandLum >= 145.0 - tw) {
    let inner = mix(yellow, green, softThreshold(bandLum, 145.0, tw));
    return mix(inner, dark, softThreshold(bandLum, 158.0, tw));
  }
  if (bandLum >= 128.0 - tw) {
    return mix(borderYellow, yellow, softThreshold(bandLum, 145.0, tw));
  }
  if (bandLum >= 125.0 - tw) {
    return mix(dark, borderYellow, softThreshold(bandLum, 128.0, tw));
  }
  return dark;
}
