


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

@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex        : texture_2d<f32>;
@group(0) @binding(4) var classMask  : texture_2d<u32>;
@group(0) @binding(5) var profileLut : texture_2d<f32>;

struct FragUniforms {
  avgLuminance     : f32,
  layerOpacity     : f32,
  colorMode        : f32,
  useMask          : f32,
  sobelEnabled     : f32,
  softCropEnabled  : f32,
  /** 1 = sample the colour-profile LUT instead of the classic band branches. */
  profileMode      : f32,
  /** 1 = lift luminance by the classic lightDark term before LUT lookup. */
  profileLightDark : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

/**
 * Named colour profile lookup (docs/COLOR_PROFILES.md). Column = preprocessed
 * luminance bucket, row = layer index. `ceil` matches the CPU band rule
 * (`value > min && value <= max`) exactly for integer band bounds.
 */
fn profileColor(layerIndex : i32, lum : f32) -> vec4<f32> {
  let lift  = select(
    0.0,
    (128.0 + abs(fragUniforms.avgLuminance - 128.0) * 0.5) * 0.5,
    fragUniforms.profileLightDark > 0.5,
  );
  let value = clamp(lum + lift, 0.0, 255.0);
  let col   = clamp(i32(ceil(value)), 0, 255);
  return textureLoad(profileLut, vec2<i32>(col, layerIndex), 0);
}

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {

  let sample = textureSample(tex, texSampler, uv);
  let rawLum = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;
  let lum    = sobelBoostedLuminance(tex, texSampler, uv, rawLum, fragUniforms.sobelEnabled);
  let dims   = vec2<f32>(textureDimensions(classMask));
  let maskUv = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.99999994));
  let maskPx = vec2<i32>(maskUv * dims);
  let band   = textureLoad(classMask, maskPx, 0).r;

  var result = vec4<f32>(0.0, 0.0, 0.0, 0.0);


  if (fragUniforms.profileMode > 0.5) {
    return profileColor(1, lum);
  }

  if (fragUniforms.colorMode == 1.0) {
    // --- CHROMASHIFT GRADIENT ---
    if (lum > 177.0 && lum <= 190.0)      { result = vec4<f32>(band_gradient(lum, 177.0, 190.0, 255.0, 290.0, 1.0, 0.40, 0.55), 1.0); }
    else if (lum > 158.0 && lum <= 177.0) { result = vec4<f32>(band_gradient(lum, 158.0, 177.0, 220.0, 255.0, 1.0, 0.38, 0.50), 1.0); }
  } else if (fragUniforms.colorMode >= 1.5) {
    // --- CROP MODE (2.0) / CROP NUNIF2 (3.0) ---
    let isNunif2  = fragUniforms.colorMode > 2.5;
    // CR0P (mode 2) uses raw luminance to match the go.1ink.us/chromashift reference;
    // NUNIF2 (mode 3) keeps its luminance lift.
    let adj       = lum + (128.0 + abs(fragUniforms.avgLuminance - 128.0) * 0.5) * 0.5;
    let bandLum   = select(lum, adj, isNunif2);
    let nonAlpha  = select(1.0, 0.777, isNunif2);  // NUNIF2 Layer 2 opacity = 0.777
    let darkAlpha = select(0.0, 0.1, isNunif2);
    result = cropLayer1Color(bandLum, fragUniforms.softCropEnabled, nonAlpha, darkAlpha);
  } else {
    // --- ORIGINAL CR0P FIXED ---
    let diff      = (fragUniforms.avgLuminance / 255.0) * 32.0;
    let lightDark = 128.0 + (abs(fragUniforms.avgLuminance - 128.0) / 2.0);
    let rgb       = lum + lightDark / 2.0;
    let grey      = fragUniforms.avgLuminance;
    let useMask   = fragUniforms.useMask > 0.5;

    if (useMask) {
      if (band == 4u) {
        result = vec4<f32>((128.0 - diff) / 255.0, 0.0, 1.0, 1.0);
      } else if (band == 5u) {
        result = vec4<f32>(0.0, 0.0, (255.0 - diff) / 255.0, 1.0);
      } else if (band == 6u) {
        result = vec4<f32>(0.0, 0.0, 1.0, 1.0);
      } else if (band == 10u) {
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        result = vec4<f32>(g, g, g, 1.0);
      }
    } else {
      let tw = 2.2; // must match the value used in Red/Orange for consistent edges
      if (rgb > 177.0 && rgb <= 190.0) {
        result = vec4<f32>((128.0 - diff) / 255.0, 0.0, 1.0, 1.0);
      } else if (rgb > 161.0 && rgb <= 177.0) {
        result = vec4<f32>(0.0, 0.0, (255.0 - diff) / 255.0, 1.0);
      } else if (rgb > 158.0 && rgb <= 161.0) {
        result = vec4<f32>(0.0, 0.0, 1.0, 1.0);
      } else if (rgb <= 126.0 + tw) {
        let t = 1.0 - softThreshold(rgb, 126.0, tw);
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        let borderBlue = vec4<f32>(0.0, 0.0, 1.0, 1.0);
        result = mix(vec4<f32>(g, g, g, 1.0), borderBlue, t);
      }
    }
  }

  return result;
}