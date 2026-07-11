import { BAND, type BandName } from '../math/bandClassification';

/**
 * Band thresholds formatted as WGSL f32 literals (e.g. "229.0"), generated
 * from the canonical BAND table so GPU shaders cannot drift from the TS/C++
 * classifiers. Interpolate these into WGSL template strings instead of
 * writing numeric thresholds by hand.
 */
export const BAND_WGSL = Object.fromEntries(
  (Object.entries(BAND) as [BandName, number][]).map(([name, value]) => [
    name,
    value.toFixed(1),
  ]),
) as Record<BandName, string>;

// ─── Vertex: rotate/flip layers (3 copies, one per layer) ──────────────────────────────────────────────────
export const vertexShaderSource = /* wgsl */ `
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

// ─── HSL / luminance / soft-crop helpers shared by the 3 layer shaders ────────
const B = BAND_WGSL;

export const WGSL_COLOR_HELPERS = /* wgsl */ `
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
    if (bandLum >= ${B.greyHighlight}) { return grey; }
    if (bandLum >= ${B.orange}) { return orange; }
    if (bandLum >= ${B.borderRed}) { return red; }
    return dark;
  }
  let tw = SOFT_CROP_TW;
  if (bandLum >= ${B.greyHighlight} - tw) {
    return mix(orange, grey, softThreshold(bandLum, ${B.greyHighlight}, tw));
  }
  if (bandLum >= ${B.orange} - tw) {
    return mix(red, orange, softThreshold(bandLum, ${B.orange}, tw));
  }
  if (bandLum >= ${B.borderRed} - tw) {
    return mix(dark, red, softThreshold(bandLum, ${B.borderRed}, tw));
  }
  return dark;
}

fn cropLayer1Color(bandLum: f32, soft: f32, nonAlpha: f32, darkAlpha: f32) -> vec4<f32> {
  let violet = vec4<f32>(0.502, 0.0, 0.502, nonAlpha);
  let blue = vec4<f32>(0.0, 0.0, 0.545, nonAlpha);
  let borderBlue = vec4<f32>(0.0, 0.0, 1.0, nonAlpha);
  let dark = vec4<f32>(0.0, 0.0, 0.0, darkAlpha);
  if (soft < 0.5) {
    if (bandLum >= ${B.violet} && bandLum < ${B.borderRed}) { return violet; }
    if (bandLum >= ${B.blue} && bandLum < ${B.violet}) { return blue; }
    if (bandLum >= ${B.borderBlue} && bandLum < ${B.blue}) { return borderBlue; }
    return dark;
  }
  let tw = SOFT_CROP_TW;
  if (bandLum >= ${B.violet} - tw) {
    let inner = mix(blue, violet, softThreshold(bandLum, ${B.violet}, tw));
    return mix(inner, dark, softThreshold(bandLum, ${B.borderRed}, tw));
  }
  if (bandLum >= ${B.blue} - tw) {
    return mix(borderBlue, blue, softThreshold(bandLum, ${B.violet}, tw));
  }
  if (bandLum >= ${B.borderBlue} - tw) {
    return mix(dark, borderBlue, softThreshold(bandLum, ${B.blue}, tw));
  }
  return dark;
}

fn cropLayer2Color(bandLum: f32, soft: f32, nonAlpha: f32, darkAlpha: f32) -> vec4<f32> {
  let green = vec4<f32>(0.0, 0.502, 0.0, nonAlpha);
  let yellow = vec4<f32>(0.502, 1.0, 0.0, nonAlpha);
  let borderYellow = vec4<f32>(1.0, 1.0, 0.0, nonAlpha);
  let dark = vec4<f32>(0.0, 0.0, 0.0, darkAlpha);
  if (soft < 0.5) {
    if (bandLum >= ${B.green} && bandLum < ${B.borderBlue}) { return green; }
    if (bandLum >= ${B.yellow} && bandLum < ${B.green}) { return yellow; }
    if (bandLum >= ${B.borderYellow} && bandLum < ${B.yellow}) { return borderYellow; }
    return dark;
  }
  let tw = SOFT_CROP_TW;
  if (bandLum >= ${B.green} - tw) {
    let inner = mix(yellow, green, softThreshold(bandLum, ${B.green}, tw));
    return mix(inner, dark, softThreshold(bandLum, ${B.borderBlue}, tw));
  }
  if (bandLum >= ${B.yellow} - tw) {
    return mix(borderYellow, yellow, softThreshold(bandLum, ${B.green}, tw));
  }
  if (bandLum >= ${B.borderYellow} - tw) {
    return mix(dark, borderYellow, softThreshold(bandLum, ${B.yellow}, tw));
  }
  return dark;
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
export const WGSL_BLEND_HELPERS = /* wgsl */ `
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
