export { BAND_GLSL, BAND_SHADER_FLOAT, BAND_WGSL, DARK_BAND_RGB_MAX } from './bandLiterals';
import { CANONICAL_LAYER_SPECS } from '../graph/layerSpecs';
import { emitColorHelpersWgsl } from '../graph/templates/wgsl';

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

// ─── HSL / luminance / soft-crop helpers shared by every layer shader ────────
/**
 * HSL / luminance / soft-crop helpers shared by every layer shader. Emitted
 * from the graph's WGSL template library so the crop ramps track the layer
 * table rather than being written out three times.
 */
export const WGSL_COLOR_HELPERS = emitColorHelpersWgsl(CANONICAL_LAYER_SPECS);

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
