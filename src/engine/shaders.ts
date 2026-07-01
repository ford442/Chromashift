// Chromashift shaders – everything needed for the WebGPU renderer

// ─── Vertex: rotate/flip layers (3 copies, one per layer) ──────────────────────────────────────────────────
const vertexShaderCommon = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0)       uv       : vec2<f32>,
};

struct Uniforms {
  angleRad : f32,
  flipX    : f32,   // 1.0 = flip, 0.0 = normal
  flipY    : f32,
  aspect   : f32,   // canvas.width / canvas.height
};
@group(0) @binding(0) var<uniform> u : Uniforms;

// Corners of a full-screen quad (NDC -1..+1)
const POS = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
  vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
);

// Texture UVs that match those positions
const UV = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0),
  vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 0.0)
);

@vertex
fn main(@builtin(vertex_index) vi : u32) -> VertexOutput {
  var pos = POS[vi];
  var uv  = UV[vi];

  // Apply flip BEFORE rotation
  uv.x = mix(uv.x, 1.0 - uv.x, u.flipX);
  uv.y = mix(uv.y, 1.0 - uv.y, u.flipY);

  // Rotate around center (0.5,0.5)
  let c = cos(u.angleRad);
  let s = sin(u.angleRad);
  let ctr = vec2<f32>(0.5, 0.5);
  let p = uv - ctr;

  // Correct for aspect ratio so rotation looks circular not elliptical
  let aspectCorrection = vec2<f32>(1.0, u.aspect);
  let pAspect = p * aspectCorrection;
  let rotated = vec2<f32>(
    pAspect.x * c - pAspect.y * s,
    pAspect.x * s + pAspect.y * c
  );
  uv = rotated / aspectCorrection + ctr;

  var out : VertexOutput;
  out.position = vec4<f32>(pos, 0.0, 1.0);
  out.uv = uv;
  return out;
}
`;

export const vertexShaderSource = vertexShaderCommon;

// ─── HSL helper for Chromashift gradient mode ────────────────────────────────────────
const WGSL_COLOR_HELPERS = /* wgsl */ `
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
`;

// ─── Fragment: Layer 0 – Red / Orange ──────────────────────────────────────────────
export const fragmentShaderRedOrange = /* wgsl */ `
${WGSL_COLOR_HELPERS}
@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex        : texture_2d<f32>;
@group(0) @binding(4) var classMask  : texture_2d<u32>;

struct FragUniforms {
  avgLuminance     : f32,
  layerOpacity     : f32,
  colorMode        : f32,
  useMask          : f32,
  sobelEnabled     : f32,
  softCropEnabled  : f32,
  _pad0            : f32,
  _pad1            : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

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

  if (fragUniforms.colorMode == 1.0) {
    // --- CHROMASHIFT GRADIENT ---
    if (lum > 229.0)      { result = vec4<f32>(band_gradient(lum, 229.0, 255.0, 45.0, 60.0, 0.3, 0.80, 1.0), 1.0); }
    else if (lum > 209.0) { result = vec4<f32>(band_gradient(lum, 209.0, 229.0, 10.0, 40.0, 1.0, 0.50, 0.65), 1.0); }
    else if (lum > 190.0) { result = vec4<f32>(band_gradient(lum, 190.0, 209.0, 0.0, 10.0, 1.0, 0.40, 0.55), 1.0); }
  } else if (fragUniforms.colorMode >= 1.5) {
    // --- CROP MODE (2.0) / CROP NUNIF2 (3.0) ---
    let isNunif2  = fragUniforms.colorMode > 2.5;
    // CR0P (mode 2) maps pixels straight from raw luminance so its bands line up
    // exactly with the go.1ink.us/chromashift reference. NUNIF2 (mode 3) keeps the
    // luminance lift: lum += (128 + |avgLum - 128| / 2) / 2.
    let adj       = lum + (128.0 + abs(fragUniforms.avgLuminance - 128.0) * 0.5) * 0.5;
    let bandLum   = select(lum, adj, isNunif2);
    let nonAlpha  = select(1.0, 0.5, isNunif2);   // NUNIF2 Layer 1 opacity = 0.5
    let darkAlpha = select(0.0, 0.1, isNunif2);
    result = cropLayer0Color(bandLum, fragUniforms.softCropEnabled, nonAlpha, darkAlpha);
  } else {
    // --- ORIGINAL CR0P FIXED ---
    let diff      = (fragUniforms.avgLuminance / 255.0) * 32.0;
    let lightDark = 128.0 + (abs(fragUniforms.avgLuminance - 128.0) / 2.0);
    let rgb       = lum + lightDark / 2.0;
    let grey      = fragUniforms.avgLuminance;
    let useMask   = fragUniforms.useMask > 0.5;

    if (useMask) {
      if (band == 0u) {
        let g = clamp((grey + (rgb - 229.0)) / 255.0, 0.0, 1.0);
        result = vec4<f32>(g, g, g, 1.0);
      } else if (band == 1u) {
        result = vec4<f32>(1.0, (128.0 - diff) / 255.0, 0.0, 1.0);
      } else if (band == 2u) {
        result = vec4<f32>((255.0 - diff) / 255.0, 0.0, 0.0, 1.0);
      } else if (band == 3u) {
        result = vec4<f32>(1.0, 0.0, 0.0, 1.0);
      } else if (band == 10u) {
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        result = vec4<f32>(g, g, g, 1.0);
      }
    } else {
      // Softened thresholds (see softThreshold helper above). The 2.2-unit
      // transition width gives noticeably smoother edges on real photos
      // without destroying the distinct colour band identity.
      let tw = 2.2;
      if (rgb > 229.0 - tw) {
        let t = softThreshold(rgb, 229.0, tw);
        let g = clamp((grey + (rgb - 229.0)) / 255.0, 0.0, 1.0);
        // Fade highlight grey into the orange band for anti-aliasing
        let orange = vec4<f32>(1.0, (128.0 - diff) / 255.0, 0.0, 1.0);
        result = mix(orange, vec4<f32>(g, g, g, 1.0), t);
      } else if (rgb > 209.0) {
        result = vec4<f32>(1.0, (128.0 - diff) / 255.0, 0.0, 1.0);
      } else if (rgb > 193.0) {
        result = vec4<f32>((255.0 - diff) / 255.0, 0.0, 0.0, 1.0);
      } else if (rgb > 190.0) {
        result = vec4<f32>(1.0, 0.0, 0.0, 1.0);
      } else if (rgb <= 126.0 + tw) {
        let t = 1.0 - softThreshold(rgb, 126.0, tw);
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        // Blend dark grey into the lowest red band
        let borderRed = vec4<f32>(1.0, 0.0, 0.0, 1.0);
        result = mix(vec4<f32>(g, g, g, 1.0), borderRed, t);
      }
    }
  }

  return result;
}`;

// ─── Fragment: Layer 1 – Violet / Blue ──────────────────────────────────────────────
export const fragmentShaderVioletBlue = /* wgsl */ `
${WGSL_COLOR_HELPERS}
@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex        : texture_2d<f32>;
@group(0) @binding(4) var classMask  : texture_2d<u32>;

struct FragUniforms {
  avgLuminance     : f32,
  layerOpacity     : f32,
  colorMode        : f32,
  useMask          : f32,
  sobelEnabled     : f32,
  softCropEnabled  : f32,
  _pad0            : f32,
  _pad1            : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

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
}`;

// ─── Fragment: Layer 2 – Green / Yellow ──────────────────────────────────────────────
export const fragmentShaderGreenYellow = /* wgsl */ `
${WGSL_COLOR_HELPERS}
@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex        : texture_2d<f32>;
@group(0) @binding(4) var classMask  : texture_2d<u32>;

struct FragUniforms {
  avgLuminance     : f32,
  layerOpacity     : f32,
  colorMode        : f32,
  useMask          : f32,
  sobelEnabled     : f32,
  softCropEnabled  : f32,
  _pad0            : f32,
  _pad1            : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

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

  if (fragUniforms.colorMode == 1.0) {
    // --- CHROMASHIFT GRADIENT ---
    if (lum > 145.0 && lum <= 158.0)      { result = vec4<f32>(band_gradient(lum, 145.0, 158.0, 90.0, 130.0, 1.0, 0.38, 0.50), 1.0); }
    else if (lum > 125.0 && lum <= 145.0) { result = vec4<f32>(band_gradient(lum, 125.0, 145.0, 50.0, 90.0, 1.0, 0.40, 0.52), 1.0); }
  } else if (fragUniforms.colorMode >= 1.5) {
    // --- CROP MODE (2.0) / CROP NUNIF2 (3.0) ---
    let isNunif2  = fragUniforms.colorMode > 2.5;
    // CR0P (mode 2) uses raw luminance to match the go.1ink.us/chromashift reference;
    // NUNIF2 (mode 3) keeps its luminance lift.
    let adj       = lum + (128.0 + abs(fragUniforms.avgLuminance - 128.0) * 0.5) * 0.5;
    let bandLum   = select(lum, adj, isNunif2);
    let nonAlpha  = select(1.0, 0.777, isNunif2);  // NUNIF2 Layer 3 opacity = 0.777
    let darkAlpha = select(0.0, 0.1, isNunif2);
    result = cropLayer2Color(bandLum, fragUniforms.softCropEnabled, nonAlpha, darkAlpha);
  } else {
    // --- ORIGINAL CR0P FIXED ---
    let diff      = (fragUniforms.avgLuminance / 255.0) * 32.0;
    let lightDark = 128.0 + (abs(fragUniforms.avgLuminance - 128.0) / 2.0);
    let rgb       = lum + lightDark / 2.0;
    let grey      = fragUniforms.avgLuminance;
    let useMask   = fragUniforms.useMask > 0.5;

    if (useMask) {
      if (band == 7u) {
        result = vec4<f32>(0.0, (255.0 - diff) / 255.0, 0.0, 1.0);
      } else if (band == 8u) {
        result = vec4<f32>(1.0, (255.0 - diff) / 255.0, 0.0, 1.0);
      } else if (band == 9u) {
        result = vec4<f32>(1.0, 1.0, 0.0, 1.0);
      } else if (band == 10u) {
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        result = vec4<f32>(g, g, g, 1.0);
      }
    } else {
      let tw = 2.2; // consistent with other layers for coherent soft edges across bands
      if (rgb > 145.0 && rgb <= 158.0) {
        result = vec4<f32>(0.0, (255.0 - diff) / 255.0, 0.0, 1.0);
      } else if (rgb > 128.0 && rgb <= 145.0) {
        result = vec4<f32>(1.0, (255.0 - diff) / 255.0, 0.0, 1.0);
      } else if (rgb > 125.0 && rgb <= 128.0) {
        result = vec4<f32>(1.0, 1.0, 0.0, 1.0);
      } else if (rgb <= 126.0 + tw) {
        let t = 1.0 - softThreshold(rgb, 126.0, tw);
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        let borderYellow = vec4<f32>(1.0, 1.0, 0.0, 1.0);
        result = mix(vec4<f32>(g, g, g, 1.0), borderYellow, t);
      }
    }
  }

  return result;
}
`;

// ─── Full-screen quad vertex (no transform) ──────────────────────────────────────────────────
export const fullscreenVertexSource = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0)       uv       : vec2<f32>,
};

const POS = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
  vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0)
);
const UV  = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0),
  vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 0.0)
);

@vertex
fn main(@builtin(vertex_index) vi : u32) -> VertexOutput {
  var out : VertexOutput;
  out.position = vec4<f32>(POS[vi], 0.0, 1.0);
  out.uv = UV[vi];
  return out;
}
`;

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

export const persistenceFragmentSource = /* wgsl */ `
@group(0) @binding(0) var cSampler  : sampler;
@group(0) @binding(1) var layer0    : texture_2d<f32>;
@group(0) @binding(2) var layer1    : texture_2d<f32>;
@group(0) @binding(3) var layer2    : texture_2d<f32>;
@group(0) @binding(4) var prevTex   : texture_2d<f32>;

struct PersistUniforms {
  decayFactor : f32,
  colorThresh : f32,
  stampBoost  : f32,
  tracerMode  : u32,
  peakMode    : u32,
  _pad0       : u32,
  _pad1       : u32,
  _pad2       : u32,
};
@group(0) @binding(5) var<uniform> pu : PersistUniforms;

struct FragmentOutputs {
  @location(0) persistence : vec4<f32>,
  @location(1) stampDiagnostic : vec4<f32>,
};

@fragment
fn main(@location(0) uv : vec2<f32>) -> FragmentOutputs {
  let c0 = textureSample(layer0, cSampler, uv);
  let c1 = textureSample(layer1, cSampler, uv);
  let c2 = textureSample(layer2, cSampler, uv);
  let prev = textureSample(prevTex, cSampler, uv);

  // Count how many layers have visible color at this pixel
  var layerCount = 0u;
  let thresh = pu.colorThresh;
  if (c0.a > thresh) { layerCount = layerCount + 1u; }
  if (c1.a > thresh) { layerCount = layerCount + 1u; }
  if (c2.a > thresh) { layerCount = layerCount + 1u; }

  // Default to zero alpha (empty)
  var newColor = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var dominantLayer = 0u;
  var stampVariance = 0.0;

  // Stamp a tracer ghost when 2+ layers overlap (much more likely than all 3).
  // Skip when all active layers are the same colour — this prevents full-image
  // grey tracer accumulation in dark areas where every layer outputs identical grey.
  if (layerCount >= 2u) {
    var sum = vec3<f32>(0.0);
    if (c0.a > thresh) { sum = sum + c0.rgb; }
    if (c1.a > thresh) { sum = sum + c1.rgb; }
    if (c2.a > thresh) { sum = sum + c2.rgb; }
    let combined = sum / f32(layerCount);

    // Measure colour variance among active layers
    var variance = 0.0;
    if (c0.a > thresh) { variance = variance + length(c0.rgb - combined); }
    if (c1.a > thresh) { variance = variance + length(c1.rgb - combined); }
    if (c2.a > thresh) { variance = variance + length(c2.rgb - combined); }
    stampVariance = variance;

    if (variance > 0.01) {
      // Determine which layer contributed most to the combined colour
      var maxLum = 0.0;
      if (c0.a > thresh) {
        let lum = dot(c0.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (lum > maxLum) { maxLum = lum; dominantLayer = 0u; }
      }
      if (c1.a > thresh) {
        let lum = dot(c1.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (lum > maxLum) { maxLum = lum; dominantLayer = 1u; }
      }
      if (c2.a > thresh) {
        let lum = dot(c2.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (lum > maxLum) { maxLum = lum; dominantLayer = 2u; }
      }

      if (pu.tracerMode == 1u) {
        let lum = dot(combined, vec3<f32>(0.2126, 0.7152, 0.0722));
        // Boost grey highlight for visibility
        let boosted = min(lum * pu.stampBoost, 1.0);
        newColor = vec4<f32>(vec3<f32>(boosted), 1.0);
      } else {
        // Brighten the combined color so tracer is visually distinct from raw layers
        let brightened = min(combined * pu.stampBoost, vec3<f32>(1.0));
        newColor = vec4<f32>(brightened, 1.0);
      }
    }
  }

  // Decay modifier: decay faster when actively overlapping, slower otherwise
  let decayMod = select(1.0, 1.5, layerCount >= 2u);
  let effectiveDecay = pow(pu.decayFactor, decayMod);
  var decayed = prev * effectiveDecay;
  if (pu.peakMode == 1u) {
    decayed = vec4<f32>(0.0);
  }

  // Keep the stronger one (new collision beats old ghost)
  let outColor = select(decayed, newColor, newColor.a > decayed.a);

  // Diagnostic output: encode stamp metadata for CPU readback / visualisation
  var diag = vec4<f32>(0.0);
  if (newColor.a > 0.5) {
    diag.r = f32(dominantLayer) / 2.0;
    diag.g = select(0.5, 1.0, layerCount >= 3u);
    diag.b = clamp(stampVariance * 10.0, 0.0, 1.0);
    diag.a = 1.0;
  }

  var out : FragmentOutputs;
  out.persistence = outColor;
  out.stampDiagnostic = diag;
  return out;
}
`;

// ─── Shared blend helpers (compositor + tracer-view) ─────────────────────────
//
// Blend-math convention: W3C Compositing and Blending Level 1
// (https://www.w3.org/TR/compositing-1/#blending).
//
// Every input to blend() must be *premultiplied*.  Layer shaders that output
// semi-transparent colours (e.g. CROP NUNIF2 with alpha=0.5/0.777) are
// premultiplied by scale_premultiplied() before they reach blend(), so
// unpremultiply() always recovers the original [0,1] colour.
//
// Reconstruction after the custom blend uses the standard "blend + over"
// formula from the spec:
//   outAlpha = s.a + d.a * (1 - s.a)
//   outRgb   = (s.rgb*s.a*(1-d.a) + d.rgb*d.a*(1-s.a) + B(d,s)*s.a*d.a) / outAlpha
//
// When either source or destination has alpha < 1 the result can look darker
// or more saturated than a naive A-over-B because the W3C model composites
// the raw source colour where the backdrop is transparent.  This is the
// standard browser/Canvas2D behaviour, not a bug.
//
// ─── Blend mode quick-reference (all formulas operate on UN-premultiplied RGB)
//   0 Alpha        – Porter-Duff source-over on premultiplied colours
//   1 Add          – min(d + s, 1)
//   2 Subtract     – max(d - s, 0)
//   3 Multiply     – d * s
//   4 Screen       – 1 - (1-d)*(1-s)
//   5 Lighten      – max(d, s)
//   6 Darken       – min(d, s)
//   7 Overlay      – Photoshop-style; destination controls the branch
//   8 Color Dodge  – clamp(d / (1-s), 0, 1)
//   9 Color Burn   – clamp(1 - (1-d)/s, 0, 1)
//  10 Difference   – abs(d - s)
//  11 Exclusion    – d + s - 2*d*s   (self-clamping in [0,1])
//  12 Hard Light   – Photoshop-style; source controls the branch
// ─────────────────────────────────────────────────────────────────────────────
const WGSL_BLEND_HELPERS = /* wgsl */ `
const BLEND_EPSILON : f32 = 0.0001;

// Issue #60 / #62: scale_premultiplied now *actually* premultiplies.
// Previously it just scaled the whole vec4 by opacity, which left
// NUNIF2 semi-transparent layers (alpha=0.5/0.777) in non-premultiplied
// form.  blend()'s unpremultiply() then divided by that alpha, inflating
// RGB beyond [0,1] and producing incorrect results for Multiply, Overlay,
// etc.  The new formula:  (rgb * alpha * opacity, alpha * opacity).
fn scale_premultiplied(color: vec4<f32>, opacity: f32) -> vec4<f32> {
  return vec4<f32>(color.rgb * color.a * opacity, color.a * opacity);
}

fn unpremultiply(color: vec4<f32>) -> vec4<f32> {
  if (color.a < BLEND_EPSILON) { return vec4<f32>(0.0); }
  return vec4<f32>(clamp(color.rgb / color.a, vec3<f32>(0.0), vec3<f32>(1.0)), color.a);
}

fn alpha_blend(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  return src + dst * (1.0 - src.a);
}

fn blend(dst: vec4<f32>, src: vec4<f32>, mode: u32) -> vec4<f32> {
  if (mode == 0u) { return alpha_blend(dst, src); }
  if (mode > 12u) { return alpha_blend(dst, src); }

  let s = unpremultiply(src);
  let d = unpremultiply(dst);
  var rgb = vec3<f32>(0.0);

  switch (mode) {
    case 1u:  { rgb = min(d.rgb + s.rgb, vec3<f32>(1.0)); }
    case 2u:  { rgb = max(d.rgb - s.rgb, vec3<f32>(0.0)); }
    case 3u:  { rgb = d.rgb * s.rgb; }
    case 4u:  { rgb = 1.0 - (1.0 - d.rgb) * (1.0 - s.rgb); }
    case 5u:  { rgb = max(d.rgb, s.rgb); }
    case 6u:  { rgb = min(d.rgb, s.rgb); }
    case 7u:  {
      // Overlay = HardLight with swapped arguments (W3C § 7.2).
      // Destination controls the branch, matching Photoshop Overlay.
      rgb = select(
        1.0 - 2.0 * (1.0 - d.rgb) * (1.0 - s.rgb),
        2.0 * d.rgb * s.rgb,
        d.rgb < vec3<f32>(0.5)
      );
    }
    case 8u:  {
      // Color Dodge: if s==1 → 1, if d==0 → 0, else min(1, d/(1-s))
      let safeDenom = max(vec3<f32>(1.0) - s.rgb, vec3<f32>(BLEND_EPSILON));
      rgb = clamp(d.rgb / safeDenom, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    case 9u:  {
      // Color Burn: if s==0 → 0, if d==1 → 1, else 1 - min(1, (1-d)/s)
      let safeSrc = max(s.rgb, vec3<f32>(BLEND_EPSILON));
      rgb = clamp(vec3<f32>(1.0) - (vec3<f32>(1.0) - d.rgb) / safeSrc, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    case 10u: { rgb = abs(d.rgb - s.rgb); }
    case 11u: { rgb = d.rgb + s.rgb - 2.0 * d.rgb * s.rgb; }
    case 12u: {
      // Hard Light: source controls the branch, matching Photoshop Hard Light.
      rgb = select(
        1.0 - 2.0 * (1.0 - s.rgb) * (1.0 - d.rgb),
        2.0 * s.rgb * d.rgb,
        s.rgb < vec3<f32>(0.5)
      );
    }
    default: { rgb = s.rgb; }
  }

  let outAlpha = s.a + d.a * (1.0 - s.a);
  if (outAlpha < BLEND_EPSILON) { return vec4<f32>(0.0); }
  let outRgb = (
    s.rgb * s.a * (1.0 - d.a) +
    d.rgb * d.a * (1.0 - s.a) +
    rgb * s.a * d.a
  ) / outAlpha;
  return vec4<f32>(outRgb * outAlpha, outAlpha);
}
`;

// ─── Compositor fragment shader ─────────────────────────────────────────────────────────────────────
//
// Blends the "Below" persistence texture, then the 3 live layers,
// then the "Above" persistence texture on top.
//
export const compositorFragmentSource = /* wgsl */ `
${WGSL_BLEND_HELPERS}

@group(0) @binding(0) var cSampler       : sampler;
@group(0) @binding(1) var layer0         : texture_2d<f32>;
@group(0) @binding(2) var layer1         : texture_2d<f32>;
@group(0) @binding(3) var layer2         : texture_2d<f32>;
@group(0) @binding(4) var persistBelow   : texture_2d<f32>;
@group(0) @binding(5) var persistAbove   : texture_2d<f32>;

struct CompositorUniforms {
  tracerAboveOpacity : f32,
  tracerBelowOpacity : f32,
  layerBlendMode     : u32,
  tracerBlendMode    : u32,
  layerOpacity0      : f32,
  layerOpacity1      : f32,
  layerOpacity2      : f32,
  diagnosticsOpacity : f32,
  stampBoost         : f32,
  outputMode         : u32,
  tracerMode         : u32,
  diagnosticsMode    : u32,
  viewportQuarterZoom: u32,
};
@group(0) @binding(6) var<uniform> cu : CompositorUniforms;

fn viewportSampleUV(uv: vec2<f32>) -> vec2<f32> {
  if (cu.viewportQuarterZoom == 0u) {
    return uv;
  }
  // Magnify the bottom-left quarter (x: 0–0.5, y: 0.5–1.0) to fill the canvas.
  return vec2<f32>(uv.x * 0.5, uv.y * 0.5 + 0.5);
}

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let sampleUV = viewportSampleUV(uv);
  let c0      = textureSample(layer0,       cSampler, sampleUV);
  let c1      = textureSample(layer1,       cSampler, sampleUV);
  let c2      = textureSample(layer2,       cSampler, sampleUV);
  let pBelow  = textureSample(persistBelow, cSampler, sampleUV);
  let pAbove  = textureSample(persistAbove, cSampler, sampleUV);

  let pBelowScaled = scale_premultiplied(pBelow, cu.tracerBelowOpacity);
  let pAboveScaled = scale_premultiplied(pAbove, cu.tracerAboveOpacity);

  let c0Opaque = scale_premultiplied(c0, cu.layerOpacity0);
  let c1Opaque = scale_premultiplied(c1, cu.layerOpacity1);
  let c2Opaque = scale_premultiplied(c2, cu.layerOpacity2);

  // 1. Blend the main active layers together
  var layerCol = vec4<f32>(0.0);
  layerCol = blend(layerCol, c2Opaque, cu.layerBlendMode);
  layerCol = blend(layerCol, c1Opaque, cu.layerBlendMode);
  layerCol = blend(layerCol, c0Opaque, cu.layerBlendMode);

  let thresh = 0.05;
  var layerCount = 0u;
  if (c0Opaque.a > thresh) { layerCount = layerCount + 1u; }
  if (c1Opaque.a > thresh) { layerCount = layerCount + 1u; }
  if (c2Opaque.a > thresh) { layerCount = layerCount + 1u; }

  var stamp = vec4<f32>(0.0);
  if (layerCount >= 2u) {
    var sum = vec3<f32>(0.0);
    if (c0Opaque.a > thresh) { sum = sum + c0Opaque.rgb; }
    if (c1Opaque.a > thresh) { sum = sum + c1Opaque.rgb; }
    if (c2Opaque.a > thresh) { sum = sum + c2Opaque.rgb; }
    let combined = sum / f32(layerCount);

    var variance = 0.0;
    if (c0Opaque.a > thresh) { variance = variance + length(c0Opaque.rgb - combined); }
    if (c1Opaque.a > thresh) { variance = variance + length(c1Opaque.rgb - combined); }
    if (c2Opaque.a > thresh) { variance = variance + length(c2Opaque.rgb - combined); }

    if (variance > 0.01) {
      if (cu.tracerMode == 1u) {
        let lum = dot(combined, vec3<f32>(0.2126, 0.7152, 0.0722));
        let boosted = min(lum * cu.stampBoost, 1.0);
        stamp = vec4<f32>(vec3<f32>(boosted), 1.0);
      } else {
        let brightened = min(combined * cu.stampBoost, vec3<f32>(1.0));
        stamp = vec4<f32>(brightened, 1.0);
      }
    }
  }

  // 2. Build the final depth stack based on output mode
  var finalCol = vec4<f32>(0.0);

  if (cu.outputMode == 1u) {
    // Tracer Focus: layers first, then both tracers on top
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pBelowScaled, cu.tracerBlendMode);
    finalCol = blend(finalCol, pAboveScaled, cu.tracerBlendMode);
  } else if (cu.outputMode == 2u) {
    // Tracer Only: suppress live layers
    finalCol = blend(finalCol, pBelowScaled, cu.tracerBlendMode);
    finalCol = blend(finalCol, pAboveScaled, cu.tracerBlendMode);
  } else if (cu.outputMode == 3u) {
    finalCol = stamp;
  } else {
    // Mixed (default): Below -> Layers -> Above
    finalCol = blend(finalCol, pBelowScaled, cu.tracerBlendMode);
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pAboveScaled, cu.tracerBlendMode);
  }

  // Force opaque output. Without this, no-layer / no-tracer regions produce
  // alpha=0 pixels and some browser/GPU combos let the OS compositor see
  // through the canvas even though alphaMode is 'opaque' on the swapchain.
  // Subtle filmic tonemapping + gentle exposure lift. The pipeline works in
  // 16-bit float, but the swapchain is 8 bpc — a cheap tonemap here
  // distributes energy better across quantisation steps, reducing banding.
  let x = finalCol.rgb * 1.04;                // tiny exposure bias
  var tonemapped = x / (x + vec3<f32>(0.15)); // very soft Reinhard variant
  if (cu.diagnosticsMode == 1u) {
    let diagBase = vec3<f32>(
      clamp(c0Opaque.a, 0.0, 1.0),
      clamp(c1Opaque.a, 0.0, 1.0),
      clamp(c2Opaque.a, 0.0, 1.0)
    );
    var collisionTint = vec3<f32>(0.0);
    if (layerCount == 2u) {
      collisionTint = vec3<f32>(1.0, 0.82, 0.18);
    } else if (layerCount >= 3u) {
      collisionTint = vec3<f32>(1.0, 1.0, 1.0);
    }
    let diagOverlay = max(diagBase, collisionTint * stamp.a);
    tonemapped = mix(tonemapped, diagOverlay, clamp(cu.diagnosticsOpacity, 0.0, 1.0));
  }
  return vec4<f32>(tonemapped, 1.0);
}
`;

// ─── Tracer View (centered aspect-fit blit, issues #58/#59/#61) ──────────────
// "Show Full Tracer" inspection path. Previously bypassed the compositor
// entirely, causing mismatched hue/brightness and ignoring user controls.
// Now uses the same blend helpers and Reinhard tonemap, respects
// tracerAboveOpacity/tracerBelowOpacity/tracerBlendMode, and still preserves
// the aspect-fit letterboxing for non-1.0 tracerScale values.
export const tracerViewFragmentSource = /* wgsl */ `
${WGSL_BLEND_HELPERS}

@group(0) @binding(0) var texSampler  : sampler;
@group(0) @binding(1) var persistAbove: texture_2d<f32>;
@group(0) @binding(2) var persistBelow: texture_2d<f32>;
@group(0) @binding(3) var layer0      : texture_2d<f32>;
@group(0) @binding(4) var layer1      : texture_2d<f32>;
@group(0) @binding(5) var layer2      : texture_2d<f32>;

struct TracerViewUniforms {
  canvasAspect       : f32,
  texAspect          : f32,
  tracerAboveOpacity : f32,
  tracerBelowOpacity : f32,
  tracerBlendMode    : u32,
  showHeatmap        : u32,
  zoom               : f32,
  panX               : f32,
  panY               : f32,
  heatmapOpacity     : f32,
  exposure           : f32,
  applyTonemap       : u32,
  showLayers         : u32,
  layerBlendMode     : u32,
  layerOpacity0      : f32,
  layerOpacity1      : f32,
  layerOpacity2      : f32,
};
@group(0) @binding(6) var<uniform> tvu : TracerViewUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  // Aspect-fit letterboxing so tracerScale != 1.0 still looks correct.
  let cA = tvu.canvasAspect;
  let tA = tvu.texAspect;

  var sampleUV = uv;
  if (cA > tA + 0.0001) {
    let visW = tA / cA;
    let x0 = (1.0 - visW) * 0.5;
    if (uv.x < x0 || uv.x > x0 + visW) {
      return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    sampleUV.x = (uv.x - x0) / visW;
  } else if (tA > cA + 0.0001) {
    let visH = cA / tA;
    let y0 = (1.0 - visH) * 0.5;
    if (uv.y < y0 || uv.y > y0 + visH) {
      return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    sampleUV.y = (uv.y - y0) / visH;
  }

  let zoom = max(tvu.zoom, 1.0);
  sampleUV = (sampleUV - vec2<f32>(0.5, 0.5)) / zoom + vec2<f32>(0.5 + tvu.panX, 0.5 + tvu.panY);
  if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let pAbove = textureSampleLevel(persistAbove, texSampler, sampleUV, 0.0);
  let pBelow = textureSampleLevel(persistBelow, texSampler, sampleUV, 0.0);

  let pAboveScaled = scale_premultiplied(pAbove, tvu.tracerAboveOpacity);
  let pBelowScaled = scale_premultiplied(pBelow, tvu.tracerBelowOpacity);

  var col = vec4<f32>(0.0);
  col = blend(col, pBelowScaled, tvu.tracerBlendMode);
  col = blend(col, pAboveScaled, tvu.tracerBlendMode);

  // When showLayers is enabled, composite the live layers on top of the
  // tracers using the same layerBlendMode the main compositor uses.
  // This makes the tracer inspector match the artistic output as closely
  // as possible (modulo stampBoost and diagnostics overlays).
  if (tvu.showLayers == 1u) {
    let c0 = textureSampleLevel(layer0, texSampler, sampleUV, 0.0);
    let c1 = textureSampleLevel(layer1, texSampler, sampleUV, 0.0);
    let c2 = textureSampleLevel(layer2, texSampler, sampleUV, 0.0);
    let c0s = scale_premultiplied(c0, tvu.layerOpacity0);
    let c1s = scale_premultiplied(c1, tvu.layerOpacity1);
    let c2s = scale_premultiplied(c2, tvu.layerOpacity2);
    col = blend(col, c2s, tvu.layerBlendMode);
    col = blend(col, c1s, tvu.layerBlendMode);
    col = blend(col, c0s, tvu.layerBlendMode);
  }

  if (tvu.showHeatmap == 1u) {
    let c0 = textureSampleLevel(layer0, texSampler, sampleUV, 0.0);
    let c1 = textureSampleLevel(layer1, texSampler, sampleUV, 0.0);
    let c2 = textureSampleLevel(layer2, texSampler, sampleUV, 0.0);
    var count = 0u;
    if (c0.a > 0.05) { count = count + 1u; }
    if (c1.a > 0.05) { count = count + 1u; }
    if (c2.a > 0.05) { count = count + 1u; }
    var overlay = vec3<f32>(0.0);
    if (count == 2u) {
      overlay = vec3<f32>(1.0, 0.92, 0.18);
    } else if (count >= 3u) {
      overlay = vec3<f32>(1.0, 1.0, 1.0);
    }
    col.rgb = max(col.rgb, mix(col.rgb, overlay, tvu.heatmapOpacity));
  }

  // Apply the same exposure + Reinhard tonemap as the compositor.
  // exposure defaults to 1.04 and can be adjusted in the inspector controls.
  if (tvu.applyTonemap == 1u) {
    let x = col.rgb * tvu.exposure;
    let tonemapped = x / (x + vec3<f32>(0.15));
    return vec4<f32>(tonemapped, 1.0);
  }
  return vec4<f32>(col.rgb, 1.0);
}
`;

export const displayTextureFragmentSource = /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var tex        : texture_2d<f32>;

struct DisplayUniforms {
  canvasAspect : f32,
  texAspect    : f32,
  tonemap      : u32,
  _pad0        : u32,
};
@group(0) @binding(2) var<uniform> du : DisplayUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var sampleUV = uv;
  if (du.canvasAspect > du.texAspect + 0.0001) {
    let visW = du.texAspect / du.canvasAspect;
    let x0 = (1.0 - visW) * 0.5;
    if (uv.x < x0 || uv.x > x0 + visW) {
      return vec4<f32>(0.02, 0.02, 0.03, 1.0);
    }
    sampleUV.x = (uv.x - x0) / visW;
  } else if (du.texAspect > du.canvasAspect + 0.0001) {
    let visH = du.canvasAspect / du.texAspect;
    let y0 = (1.0 - visH) * 0.5;
    if (uv.y < y0 || uv.y > y0 + visH) {
      return vec4<f32>(0.02, 0.02, 0.03, 1.0);
    }
    sampleUV.y = (uv.y - y0) / visH;
  }

  let sampleColor = textureSampleLevel(tex, texSampler, sampleUV, 0.0);
  if (du.tonemap == 0u) {
    return vec4<f32>(sampleColor.rgb, 1.0);
  }

  let x = sampleColor.rgb * 1.04;
  let tonemapped = x / (x + vec3<f32>(0.15));
  return vec4<f32>(tonemapped, 1.0);
}
`;

export const coincidenceHeatmapFragmentSource = /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var layer0     : texture_2d<f32>;
@group(0) @binding(2) var layer1     : texture_2d<f32>;
@group(0) @binding(3) var layer2     : texture_2d<f32>;

struct HeatmapUniforms {
  threshold : f32,
  _pad0     : f32,
  _pad1     : u32,
  _pad2     : u32,
};
@group(0) @binding(4) var<uniform> hu : HeatmapUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c0 = textureSample(layer0, texSampler, uv);
  let c1 = textureSample(layer1, texSampler, uv);
  let c2 = textureSample(layer2, texSampler, uv);

  var count = 0u;
  if (c0.a > hu.threshold) { count = count + 1u; }
  if (c1.a > hu.threshold) { count = count + 1u; }
  if (c2.a > hu.threshold) { count = count + 1u; }

  if (count < 2u) {
    let maxBand = max(max(c0.rgb, c1.rgb), c2.rgb) * 0.22;
    return vec4<f32>(maxBand, 1.0);
  }

  let combined = c0.rgb + c1.rgb + c2.rgb;
  if (count == 2u) {
    let warm = normalize(max(combined, vec3<f32>(0.0001))) * vec3<f32>(1.0, 0.9, 0.25);
    return vec4<f32>(warm, 1.0);
  }

  let hot = vec3<f32>(1.0, 0.98, 0.98) + combined * 0.15;
  return vec4<f32>(min(hot, vec3<f32>(1.0)), 1.0);
}
`;

export const diagnosticFragmentSource = /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var layer0     : texture_2d<f32>;
@group(0) @binding(2) var layer1     : texture_2d<f32>;
@group(0) @binding(3) var layer2     : texture_2d<f32>;

struct DiagnosticUniforms {
  threshold : f32,
  opacity0  : f32,
  opacity1  : f32,
  opacity2  : f32,
};
@group(0) @binding(4) var<uniform> du : DiagnosticUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c0 = textureSample(layer0, texSampler, uv);
  let c1 = textureSample(layer1, texSampler, uv);
  let c2 = textureSample(layer2, texSampler, uv);

  let a0 = c0.a * du.opacity0;
  let a1 = c1.a * du.opacity1;
  let a2 = c2.a * du.opacity2;

  var count = 0u;
  if (a0 > du.threshold) { count = count + 1u; }
  if (a1 > du.threshold) { count = count + 1u; }
  if (a2 > du.threshold) { count = count + 1u; }

  let collision = select(0.0, select(0.67, 1.0, count >= 3u), count >= 2u);
  return vec4<f32>(clamp(vec3<f32>(a0, a1, a2), vec3<f32>(0.0), vec3<f32>(1.0)), collision);
}
`;

export const persistDiagnosticBlitFragmentSource = /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var diagTex    : texture_2d<f32>;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(diagTex, texSampler, uv);
}
`;

export const stampDiagnosticViewFragmentSource = /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var diagTex    : texture_2d<f32>;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let d = textureSample(diagTex, texSampler, uv);
  if (d.a < 0.5) {
    return vec4<f32>(0.02, 0.02, 0.03, 1.0);
  }

  var color = vec3<f32>(0.0);
  if (d.r < 0.33) {
    color = vec3<f32>(1.0, 0.0, 0.0);       // Layer 0 — Red
  } else if (d.r < 0.66) {
    color = vec3<f32>(0.5, 0.0, 1.0);       // Layer 1 — Violet
  } else {
    color = vec3<f32>(0.0, 1.0, 0.0);       // Layer 2 — Green
  }

  let intensity = 0.3 + 0.7 * d.b;
  return vec4<f32>(color * intensity, 1.0);
}
`;

export const compareFragmentSource = /* wgsl */ `
${WGSL_BLEND_HELPERS}

@group(0) @binding(0) var cSampler       : sampler;
@group(0) @binding(1) var sourceTex      : texture_2d<f32>;
@group(0) @binding(2) var layer0         : texture_2d<f32>;
@group(0) @binding(3) var layer1         : texture_2d<f32>;
@group(0) @binding(4) var layer2         : texture_2d<f32>;
@group(0) @binding(5) var persistBelow   : texture_2d<f32>;
@group(0) @binding(6) var persistAbove   : texture_2d<f32>;

struct CompareUniforms {
  sourceAspect       : f32,
  tracerAboveOpacity : f32,
  tracerBelowOpacity : f32,
  layerBlendMode     : u32,
  tracerBlendMode    : u32,
  layerOpacity0      : f32,
  layerOpacity1      : f32,
  layerOpacity2      : f32,
  stampBoost         : f32,
  dividerWidth       : f32,
  outputMode         : u32,
  tracerMode         : u32,
};
@group(0) @binding(7) var<uniform> cu : CompareUniforms;

fn compositeAt(uv : vec2<f32>) -> vec3<f32> {
  let c0 = scale_premultiplied(textureSampleLevel(layer0, cSampler, uv, 0.0), cu.layerOpacity0);
  let c1 = scale_premultiplied(textureSampleLevel(layer1, cSampler, uv, 0.0), cu.layerOpacity1);
  let c2 = scale_premultiplied(textureSampleLevel(layer2, cSampler, uv, 0.0), cu.layerOpacity2);
  let pBelow = scale_premultiplied(textureSampleLevel(persistBelow, cSampler, uv, 0.0), cu.tracerBelowOpacity);
  let pAbove = scale_premultiplied(textureSampleLevel(persistAbove, cSampler, uv, 0.0), cu.tracerAboveOpacity);

  var layerCol = vec4<f32>(0.0);
  layerCol = blend(layerCol, c2, cu.layerBlendMode);
  layerCol = blend(layerCol, c1, cu.layerBlendMode);
  layerCol = blend(layerCol, c0, cu.layerBlendMode);

  var finalCol = vec4<f32>(0.0);
  if (cu.outputMode == 1u) {
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pBelow, cu.tracerBlendMode);
    finalCol = blend(finalCol, pAbove, cu.tracerBlendMode);
  } else if (cu.outputMode == 2u) {
    finalCol = blend(finalCol, pBelow, cu.tracerBlendMode);
    finalCol = blend(finalCol, pAbove, cu.tracerBlendMode);
  } else if (cu.outputMode == 3u) {
    let thresh = 0.05;
    var layerCount = 0u;
    if (c0.a > thresh) { layerCount = layerCount + 1u; }
    if (c1.a > thresh) { layerCount = layerCount + 1u; }
    if (c2.a > thresh) { layerCount = layerCount + 1u; }
    if (layerCount >= 2u) {
      var sum = vec3<f32>(0.0);
      if (c0.a > thresh) { sum = sum + c0.rgb; }
      if (c1.a > thresh) { sum = sum + c1.rgb; }
      if (c2.a > thresh) { sum = sum + c2.rgb; }
      let combined = sum / f32(layerCount);
      if (cu.tracerMode == 1u) {
        let lum = dot(combined, vec3<f32>(0.2126, 0.7152, 0.0722));
        finalCol = vec4<f32>(vec3<f32>(min(lum * cu.stampBoost, 1.0)), 1.0);
      } else {
        finalCol = vec4<f32>(min(combined * cu.stampBoost, vec3<f32>(1.0)), 1.0);
      }
    }
  } else {
    finalCol = blend(finalCol, pBelow, cu.tracerBlendMode);
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pAbove, cu.tracerBlendMode);
  }

  let x = finalCol.rgb * 1.04;
  return x / (x + vec3<f32>(0.15));
}

fn sampleSourceFitted(uv : vec2<f32>) -> vec3<f32> {
  let halfAspect = 0.5 * cu.sourceAspect;
  var sampleUV = vec2<f32>(uv.x * 2.0, uv.y);

  if (halfAspect > 1.0 + 0.0001) {
    let visH = 1.0 / halfAspect;
    let y0 = (1.0 - visH) * 0.5;
    if (uv.y < y0 || uv.y > y0 + visH) {
      return vec3<f32>(0.02, 0.02, 0.03);
    }
    sampleUV.y = (uv.y - y0) / visH;
  } else if (1.0 > halfAspect + 0.0001) {
    let visW = halfAspect;
    let x0 = (1.0 - visW) * 0.5;
    let localX = uv.x * 2.0;
    if (localX < x0 || localX > x0 + visW) {
      return vec3<f32>(0.02, 0.02, 0.03);
    }
    sampleUV.x = (localX - x0) / visW;
  }

  return textureSampleLevel(sourceTex, cSampler, sampleUV, 0.0).rgb;
}

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let dividerHalf = max(0.001, cu.dividerWidth * 0.5);
  if (abs(uv.x - 0.5) < dividerHalf) {
    return vec4<f32>(0.96, 0.78, 0.22, 1.0);
  }

  if (uv.x < 0.5) {
    return vec4<f32>(sampleSourceFitted(uv), 1.0);
  }

  let rightUV = vec2<f32>((uv.x - 0.5) * 2.0, uv.y);
  return vec4<f32>(compositeAt(rightUV), 1.0);
}
`;
