/**
 * WGSL shaders for the Chromashift 3-layer WebGPU rendering pipeline.
 *
 * Each layer renders a full-screen quad and applies:
 *  - a mat3 rotation + flip transform in the vertex stage
 *  - a colour-channel mask with smooth HSL gradient in the fragment stage
 *
 * A 4th compositor pass detects where all 3 layers have colour (stacking)
 * and applies a tracer/ghost highlight at those points.
 */

// ─── Shared WGSL helpers (injected into each fragment shader) ─────────────────
const WGSL_COLOR_HELPERS = /* wgsl */ `
// HSL → RGB
fn hsl_to_rgb(h: f32, s: f32, l: f32) -> vec3<f32> {
  let c = (1.0 - abs(2.0 * l - 1.0)) * s;
  let hp = h / 60.0;
  let x = c * (1.0 - abs((hp % 2.0) - 1.0));
  var rgb = vec3<f32>(0.0);
  if      (hp < 1.0) { rgb = vec3<f32>(c, x, 0.0); }
  else if (hp < 2.0) { rgb = vec3<f32>(x, c, 0.0); }
  else if (hp < 3.0) { rgb = vec3<f32>(0.0, c, x); }
  else if (hp < 4.0) { rgb = vec3<f32>(0.0, x, c); }
  else if (hp < 5.0) { rgb = vec3<f32>(x, 0.0, c); }
  else               { rgb = vec3<f32>(c, 0.0, x); }
  let m = l - c / 2.0;
  return clamp(rgb + vec3<f32>(m), vec3<f32>(0.0), vec3<f32>(1.0));
}

// Smooth gradient within a luminance band: returns RGB colour
// band_lo/hi: luminance range 0-255
// hue_lo/hi: start and end hue in degrees
// sat: saturation, light_lo/hi: lightness range
fn band_gradient(
  lum      : f32,
  band_lo  : f32,
  band_hi  : f32,
  hue_lo   : f32,
  hue_hi   : f32,
  sat      : f32,
  light_lo : f32,
  light_hi : f32,
) -> vec3<f32> {
  let t     = smoothstep(band_lo, band_hi, lum);
  let hue   = mix(hue_lo, hue_hi, t);
  let light = mix(light_lo, light_hi, t);
  return hsl_to_rgb(hue, sat, light);
}
`;

export const vertexShaderSource = /* wgsl */ `
struct Uniforms {
  rotation : mat3x3<f32>,
  flipX    : u32,
  flipY    : u32,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0)       uv       : vec2<f32>,
};

@vertex
fn main(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
  );

  let clipPos = positions[vertexIndex];

  var flipped = clipPos;
  if (uniforms.flipX != 0u) { flipped.x *= -1.0; }
  if (uniforms.flipY != 0u) { flipped.y *= -1.0; }

  let rotated = uniforms.rotation * vec3<f32>(flipped, 1.0);

  var out : VertexOutput;
  out.position = vec4<f32>(rotated.xy, 0.0, 1.0);
  out.uv       = clipPos * 0.5 + 0.5;
  return out;
}
`;

// ─── Fragment: Layer 0 – Red / Orange ────────────────────────────────────────
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
  let opacity = fragUniforms.layerOpacity;

  if (lum > 229.0) {
    // Near-white highlight: desaturate toward white smoothly
    let rgb = band_gradient(lum, 229.0, 255.0, 45.0, 60.0, 0.3, 0.80, 1.0);
    return vec4<f32>(rgb, opacity);
  } else if (lum > 209.0) {
    // Orange band: red-orange → deep orange (hue 10→40)
    let rgb = band_gradient(lum, 209.0, 229.0, 10.0, 40.0, 1.0, 0.50, 0.65);
    return vec4<f32>(rgb, opacity);
  } else if (lum > 190.0) {
    // Red band: deep red → red-orange (hue 0→10)
    let rgb = band_gradient(lum, 190.0, 209.0, 0.0, 10.0, 1.0, 0.40, 0.55);
    return vec4<f32>(rgb, opacity);
  }

  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;

// ─── Fragment: Layer 1 – Violet / Blue ───────────────────────────────────────
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
  let opacity = fragUniforms.layerOpacity;

  if (lum > 177.0 && lum <= 190.0) {
    // Violet band: blue-violet → violet (hue 255→290)
    let rgb = band_gradient(lum, 177.0, 190.0, 255.0, 290.0, 1.0, 0.40, 0.55);
    return vec4<f32>(rgb, opacity);
  } else if (lum > 158.0 && lum <= 177.0) {
    // Blue band: deep blue → blue-violet (hue 220→255)
    let rgb = band_gradient(lum, 158.0, 177.0, 220.0, 255.0, 1.0, 0.38, 0.50);
    return vec4<f32>(rgb, opacity);
  }

  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;

// ─── Fragment: Layer 2 – Green / Yellow ──────────────────────────────────────
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
  let opacity = fragUniforms.layerOpacity;

  if (lum > 145.0 && lum <= 158.0) {
    // Green band: yellow-green → green (hue 90→130)
    let rgb = band_gradient(lum, 145.0, 158.0, 90.0, 130.0, 1.0, 0.38, 0.50);
    return vec4<f32>(rgb, opacity);
  } else if (lum > 125.0 && lum <= 145.0) {
    // Yellow band: warm yellow → yellow-green (hue 50→90)
    let rgb = band_gradient(lum, 125.0, 145.0, 50.0, 90.0, 1.0, 0.40, 0.52);
    return vec4<f32>(rgb, opacity);
  }

  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;

// ─── Compositor vertex shader (full-screen quad, no transforms) ──────────────
export const compositorVertexSource = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0)       uv       : vec2<f32>,
};

@vertex
fn main(@builtin(vertex_index) vi : u32) -> VertexOutput {
  var pos = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0),
  );
  let p = pos[vi];
  var out : VertexOutput;
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv       = p * 0.5 + 0.5;
  return out;
}
`;

// ─── Compositor fragment shader – blends 3 layers + tracer effect ────────────
export const compositorFragmentSource = /* wgsl */ `
@group(0) @binding(0) var cSampler : sampler;
@group(0) @binding(1) var layer0   : texture_2d<f32>;
@group(0) @binding(2) var layer1   : texture_2d<f32>;
@group(0) @binding(3) var layer2   : texture_2d<f32>;

struct CompositorUniforms {
  tracerIntensity  : f32,  // 0–1 how bright the tracer glow is
  tracerThreshold  : f32,  // min alpha to count as "has colour"
  _pad0            : f32,
  _pad1            : f32,
};
@group(0) @binding(4) var<uniform> compUniforms : CompositorUniforms;

fn alpha_blend(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  let a = src.a + dst.a * (1.0 - src.a);
  if (a < 0.0001) { return vec4<f32>(0.0); }
  let rgb = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / a;
  return vec4<f32>(rgb, a);
}

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c0 = textureSample(layer0, cSampler, uv);
  let c1 = textureSample(layer1, cSampler, uv);
  let c2 = textureSample(layer2, cSampler, uv);

  // Standard back-to-front compositing
  var col = vec4<f32>(0.0);
  col = alpha_blend(col, c2);
  col = alpha_blend(col, c1);
  col = alpha_blend(col, c0);

  // Tracer/ghost: all 3 layers have colour at this pixel with strong overlap
  // Only show tracer where all three layers have significant alpha (stacking detected)
  let thresh = compUniforms.tracerThreshold;
  let overlap = c0.a * c1.a * c2.a;  // Multiplicative overlap: high only when all 3 are present
  if (overlap > thresh * thresh) {  // Require strong overlap from all three
    // Bright cyan-white highlight at intersection points (highly visible)
    let tracer = vec4<f32>(0.8, 1.0, 1.0, 1.0);
    col = mix(col, tracer, compUniforms.tracerIntensity * 0.8);
  }

  return col;
}
`;
