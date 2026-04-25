// Chromashift shaders – everything needed for the WebGPU renderer

// ─── Shared colour utility helpers ──────────────────────────────────────────────────────────────────
const WGSL_COLOR_HELPERS = /* wgsl */ `
// Convert HSL (0–1) to RGB (0–1)
fn hsl2rgb(h: f32, s: f32, l: f32) -> vec3<f32> {
  let a = s * min(l, 1.0 - l);
  let k = (h * 6.0 + vec3<f32>(0.0, 4.0, 2.0)) / 6.0;
  let f = fract(k - floor(k));
  let cubic = f * f * (3.0 - 2.0 * f);  // smoothstep(0,1,f)
  let rgb = l - a + a * (4.0 * cubic - 12.0 * cubic + 6.0);
  return rgb;
}

// Map a luminance value into a gradient band
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
`;

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

export const vertexShaderLayer0 = vertexShaderCommon;
export const vertexShaderLayer1 = vertexShaderCommon;
export const vertexShaderLayer2 = vertexShaderCommon;

// Backward compatibility: vertexShaderSource was the old name
export const vertexShaderSource = vertexShaderCommon;

// ─── Fragment: Layer 0 – Red / Orange ──────────────────────────────────────────────
export const fragmentShaderRedOrange = /* wgsl */ `
${WGSL_COLOR_HELPERS}

@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex        : texture_2d<f32>;

struct FragUniforms {
  avgLuminance : f32,
  layerOpacity : f32,
  _pad0        : f32,
  _pad1        : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let sample  = textureSample(tex, texSampler, uv);
  let lum     = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;

  var result = vec4<f32>(0.0, 0.0, 0.0, 0.0);

  if (lum > 229.0) {
    let rgb = band_gradient(lum, 229.0, 255.0, 45.0, 60.0, 0.3, 0.80, 1.0);
    result = vec4<f32>(rgb, 1.0);
  } else if (lum > 209.0) {
    let rgb = band_gradient(lum, 209.0, 229.0, 10.0, 40.0, 1.0, 0.50, 0.65);
    result = vec4<f32>(rgb, 1.0);
  } else if (lum > 190.0) {
    let rgb = band_gradient(lum, 190.0, 209.0, 0.0, 10.0, 1.0, 0.40, 0.55);
    result = vec4<f32>(rgb, 1.0);
  }

  // Layer outputs full alpha for persistence detection
  // Opacity is applied in compositor, not here
  return result;
}`;

// ─── Fragment: Layer 1 – Violet / Blue ──────────────────────────────────────────────
export const fragmentShaderVioletBlue = /* wgsl */ `
${WGSL_COLOR_HELPERS}

@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex        : texture_2d<f32>;

struct FragUniforms {
  avgLuminance : f32,
  layerOpacity : f32,
  _pad0        : f32,
  _pad1        : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let sample  = textureSample(tex, texSampler, uv);
  let lum     = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;

  var result = vec4<f32>(0.0, 0.0, 0.0, 0.0);

  if (lum > 177.0 && lum <= 190.0) {
    let rgb = band_gradient(lum, 177.0, 190.0, 255.0, 290.0, 1.0, 0.40, 0.55);
    result = vec4<f32>(rgb, 1.0);
  } else if (lum > 158.0 && lum <= 177.0) {
    let rgb = band_gradient(lum, 158.0, 177.0, 220.0, 255.0, 1.0, 0.38, 0.50);
    result = vec4<f32>(rgb, 1.0);
  }

  // Layer outputs full alpha for persistence detection
  // Opacity is applied in compositor, not here
  return result;
}`;

// ─── Fragment: Layer 2 – Green / Yellow ──────────────────────────────────────────────
export const fragmentShaderGreenYellow = /* wgsl */ `
${WGSL_COLOR_HELPERS}

@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex        : texture_2d<f32>;

struct FragUniforms {
  avgLuminance : f32,
  layerOpacity : f32,
  _pad0        : f32,
  _pad1        : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let sample  = textureSample(tex, texSampler, uv);
  let lum     = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;

  var result = vec4<f32>(0.0, 0.0, 0.0, 0.0);

  if (lum > 145.0 && lum <= 158.0) {
    let rgb = band_gradient(lum, 145.0, 158.0, 90.0, 130.0, 1.0, 0.38, 0.50);
    result = vec4<f32>(rgb, 1.0);
  } else if (lum > 125.0 && lum <= 145.0) {
    let rgb = band_gradient(lum, 125.0, 145.0, 50.0, 90.0, 1.0, 0.40, 0.52);
    result = vec4<f32>(rgb, 1.0);
  }

  // Layer outputs full alpha for persistence detection
  // Opacity is applied in compositor, not here
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
//   8: tracerMode   (u32)  – 0 = combined colors, 1 = grey highlight
//  12: _reserved    (u32)
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
  tracerMode  : u32,
  _reserved   : u32,
};
@group(0) @binding(5) var<uniform> pu : PersistUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c0 = textureSample(layer0, cSampler, uv);
  let c1 = textureSample(layer1, cSampler, uv);
  let c2 = textureSample(layer2, cSampler, uv);
  let prev = textureSample(prevTex, cSampler, uv);

  // Overlap detection: all 3 layers must have visible color
  let thresh = pu.colorThresh;
  let allVisible = (c0.a > thresh) && (c1.a > thresh) && (c2.a > thresh);

  // Default to zero alpha (empty)
  var newColor = vec4<f32>(0.0, 0.0, 0.0, 0.0);

  // Only stamp a new tracer ghost if the layers actually overlap here
  if (allVisible) {
    if (pu.tracerMode == 1u) {
      let combined = (c0.rgb + c1.rgb + c2.rgb) / 3.0;
      let lum = dot(combined, vec3<f32>(0.2126, 0.7152, 0.0722));
      newColor = vec4<f32>(vec3<f32>(lum), 1.0);
    } else {
      newColor = vec4<f32>((c0.rgb + c1.rgb + c2.rgb) / 3.0, 1.0);
    }
  }

  // Decay modifier
  let decayMod = select(1.0, 1.5, allVisible);
  let effectiveDecay = pow(pu.decayFactor, decayMod);
  let decayed = prev * effectiveDecay;

  // Keep the stronger one (new collision beats old ghost)
  return select(decayed, newColor, newColor.a > decayed.a);
}
`;

// ─── Compositor fragment shader ─────────────────────────────────────────────────────────────────────
//
// Blends the "Below" persistence texture, then the 3 live layers,
// then the "Above" persistence texture on top.
//
export const compositorFragmentSource = /* wgsl */ `
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
  outputMode         : u32,
};
@group(0) @binding(6) var<uniform> cu : CompositorUniforms;

const BLEND_EPSILON : f32 = 0.0001;

fn scale_premultiplied(color: vec4<f32>, opacity: f32) -> vec4<f32> {
  return color * opacity;
}

fn unpremultiply(color: vec4<f32>) -> vec4<f32> {
  if (color.a < BLEND_EPSILON) { return vec4<f32>(0.0); }
  return vec4<f32>(color.rgb / color.a, color.a);
}

fn alpha_blend(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  return src + dst * (1.0 - src.a);
}

fn blend(dst: vec4<f32>, src: vec4<f32>, mode: u32) -> vec4<f32> {
  if (mode == 0u) {
    return alpha_blend(dst, src);
  }

  if (mode == 1u) {
    return src + dst;
  }

  let s = unpremultiply(src);
  let d = unpremultiply(dst);
  var rgb = vec3<f32>(0.0);

  switch (mode) {
    case 2u:  { rgb = max(d.rgb - s.rgb, vec3<f32>(0.0)); }
    case 3u:  { rgb = d.rgb * s.rgb; }
    case 4u:  { rgb = 1.0 - (1.0 - d.rgb) * (1.0 - s.rgb); }
    case 5u:  { rgb = max(d.rgb, s.rgb); }
    case 6u:  { rgb = min(d.rgb, s.rgb); }
    case 7u:  {
      rgb = select(
        1.0 - 2.0 * (1.0 - d.rgb) * (1.0 - s.rgb),
        2.0 * d.rgb * s.rgb,
        d.rgb < vec3<f32>(0.5)
      );
    }
    case 8u:  {
      let safeDenom = max(vec3<f32>(1.0) - s.rgb, vec3<f32>(BLEND_EPSILON));
      rgb = clamp(d.rgb / safeDenom, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    case 9u:  {
      let safeSrc = max(s.rgb, vec3<f32>(BLEND_EPSILON));
      rgb = clamp(vec3<f32>(1.0) - (vec3<f32>(1.0) - d.rgb) / safeSrc, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    case 10u: { rgb = abs(d.rgb - s.rgb); }
    case 11u: { rgb = d.rgb + s.rgb - 2.0 * d.rgb * s.rgb; }
    case 12u: {
      rgb = select(
        1.0 - 2.0 * (1.0 - s.rgb) * (1.0 - d.rgb),
        2.0 * s.rgb * d.rgb,
        s.rgb < vec3<f32>(0.5)
      );
    }
    default:  { rgb = s.rgb; }
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

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c0      = textureSample(layer0,       cSampler, uv);
  let c1      = textureSample(layer1,       cSampler, uv);
  let c2      = textureSample(layer2,       cSampler, uv);
  let pBelow  = textureSample(persistBelow, cSampler, uv);
  let pAbove  = textureSample(persistAbove, cSampler, uv);

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
  } else {
    // Mixed (default): Below -> Layers -> Above
    finalCol = blend(finalCol, pBelowScaled, cu.tracerBlendMode);
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pAboveScaled, cu.tracerBlendMode);
  }

  return finalCol;
}
`;

// Keep old names as aliases so nothing else breaks during transition
export const compositorVertexSource = fullscreenVertexSource;
