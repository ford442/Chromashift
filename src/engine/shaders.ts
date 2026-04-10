/**
 * WGSL shaders for the Chromashift 3-layer WebGPU rendering pipeline.
 *
 * Pipeline overview:
 *   Pass 0–2 : Each colour layer renders to its own intermediate GPUTexture
 *   Pass 3   : Persistence pass — detects multi-layer spatial overlap,
 *              blends the mixed colour into a ping-pong persistence buffer
 *              that decays over tracerDuration milliseconds
 *   Pass 4   : Compositor — blends the 3 live layers then draws the
 *              persistence buffer on top
 */

// ─── Shared WGSL helpers ──────────────────────────────────────────────────────
const WGSL_COLOR_HELPERS = /* wgsl */ `
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

// ─── Vertex shader (shared by all layer passes) ──────────────────────────────────────────────────
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

  if (lum > 229.0) {
    let rgb = band_gradient(lum, 229.0, 255.0, 45.0, 60.0, 0.3, 0.80, 1.0);
    return vec4<f32>(rgb, 1.0);
  } else if (lum > 209.0) {
    let rgb = band_gradient(lum, 209.0, 229.0, 10.0, 40.0, 1.0, 0.50, 0.65);
    return vec4<f32>(rgb, 1.0);
  } else if (lum > 190.0) {
    let rgb = band_gradient(lum, 190.0, 209.0, 0.0, 10.0, 1.0, 0.40, 0.55);
    return vec4<f32>(rgb, 1.0);
  }

  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;

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

  if (lum > 177.0 && lum <= 190.0) {
    let rgb = band_gradient(lum, 177.0, 190.0, 255.0, 290.0, 1.0, 0.40, 0.55);
    return vec4<f32>(rgb, 1.0);
  } else if (lum > 158.0 && lum <= 177.0) {
    let rgb = band_gradient(lum, 158.0, 177.0, 220.0, 255.0, 1.0, 0.38, 0.50);
    return vec4<f32>(rgb, 1.0);
  }

  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;

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

  if (lum > 145.0 && lum <= 158.0) {
    let rgb = band_gradient(lum, 145.0, 158.0, 90.0, 130.0, 1.0, 0.38, 0.50);
    return vec4<f32>(rgb, 1.0);
  } else if (lum > 125.0 && lum <= 145.0) {
    let rgb = band_gradient(lum, 125.0, 145.0, 50.0, 90.0, 1.0, 0.40, 0.52);
    return vec4<f32>(rgb, 1.0);
  }

  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;

// ─── Full-screen quad vertex (no transform) ──────────────────────────────────────────────────
export const fullscreenVertexSource = /* wgsl */ `
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

// ─── Persistence pass fragment shader ──────────────────────────────────────────────────
//
// Reads the 3 live layer textures and the previous persistence texture.
// Where 2 or more layers have colour at the same pixel, it writes the
// alpha-blended mix of those layers' colours at full strength.
// Where fewer than 2 layers overlap, it writes the previous persistence
// value multiplied by decayFactor (< 1.0), so held colours fade over time.
//
export const persistenceFragmentSource = /* wgsl */ `
@group(0) @binding(0) var samp        : sampler;
@group(0) @binding(1) var layer0      : texture_2d<f32>;
@group(0) @binding(2) var layer1      : texture_2d<f32>;
@group(0) @binding(3) var layer2      : texture_2d<f32>;
@group(0) @binding(4) var prevPersist : texture_2d<f32>;

struct PersistUniforms {
  decayFactor      : f32,  // per-frame multiplier: 0=instant, ~0.99=slow fade
  colorThreshold   : f32,  // min alpha to count a layer as "has colour" at pixel
  tracerMode       : f32,  // 0 = combined colors, 1 = grey highlight
  _pad0            : f32,
};
@group(0) @binding(5) var<uniform> pu : PersistUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c0 = textureSample(layer0, samp, uv);
  let c1 = textureSample(layer1, samp, uv);
  let c2 = textureSample(layer2, samp, uv);
  let prev = textureSample(prevPersist, samp, uv);

  let thresh = pu.colorThreshold;
  let mode   = pu.tracerMode;

  // Which layers have colour at this pixel?
  let has0 = c0.a > thresh;
  let has1 = c1.a > thresh;
  let has2 = c2.a > thresh;

  // Count overlapping layers
  let count = i32(has0) + i32(has1) + i32(has2);

  var newColor = vec4<f32>(0.0);

  if (count >= 2) {
    // 2 or 3 layers colliding → form 4th layer
    if (mode == 0.0) {
      // Combined colors (original behavior) - blend active layers
      var mixed = vec4<f32>(0.0);

      if (has0) {
        let a = c0.a;
        mixed = vec4<f32>(
          mixed.rgb * mixed.a * (1.0 - a) / max(mixed.a + a * (1.0 - mixed.a), 0.0001) + c0.rgb * a / max(mixed.a + a * (1.0 - mixed.a), 0.0001),
          mixed.a + a * (1.0 - mixed.a)
        );
      }
      if (has1) {
        let a = c1.a;
        let newA = mixed.a + a * (1.0 - mixed.a);
        mixed = vec4<f32>(
          (mixed.rgb * mixed.a + c1.rgb * a * (1.0 - mixed.a)) / max(newA, 0.0001),
          newA
        );
      }
      if (has2) {
        let a = c2.a;
        let newA = mixed.a + a * (1.0 - mixed.a);
        mixed = vec4<f32>(
          (mixed.rgb * mixed.a + c2.rgb * a * (1.0 - mixed.a)) / max(newA, 0.0001),
          newA
        );
      }
      // 3-layer collision: sharp attack (full alpha), 2-layer: slow attack (reduced alpha)
      if (count == 3) {
        newColor = vec4<f32>(mixed.rgb, 1.0);  // Sharp attack: appears fully
      } else {
        newColor = vec4<f32>(mixed.rgb, 0.7);  // Slow attack: appears gradually
      }
    } else {
      // Grey highlight mode
      newColor = vec4<f32>(0.95, 0.95, 0.90, 1.0);
    }
  }

  // Decay based on overlap intensity
  // 3 overlaps: slower decay (fades slower), 2 overlaps: normal decay
  var decayMod = 1.0;
  if (count == 2) {
    decayMod = 1.0;   // Normal decay for 2-layer hits
  } else if (count == 3) {
    decayMod = 0.7;   // Slower decay (persists longer) for 3-layer hits
  }
  let effectiveDecay = pow(pu.decayFactor, decayMod);
  let decayed = prev * effectiveDecay;

  // Keep the stronger one (new collision beats old ghost)
  // If newColor has alpha, use it; otherwise use decayed
  return select(decayed, newColor, newColor.a > decayed.a);
}
`;

// ─── Compositor fragment shader ─────────────────────────────────────────────────────────────────────
//
// Blends the 3 live layers back-to-front, then draws the persistence
// texture on top so held/fading overlaps remain visible.
//
export const compositorFragmentSource = /* wgsl */ `
@group(0) @binding(0) var cSampler   : sampler;
@group(0) @binding(1) var layer0     : texture_2d<f32>;
@group(0) @binding(2) var layer1     : texture_2d<f32>;
@group(0) @binding(3) var layer2     : texture_2d<f32>;
@group(0) @binding(4) var persistence: texture_2d<f32>;

struct CompositorUniforms {
  tracerOpacity  : f32,  // how opaque the persistence overlay is (0–1)
  tracerBelow    : f32,  // 1.0 = composite tracer below layers, 0.0 = above
  layerBlendMode : u32,  // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen
  tracerBlendMode: u32,  // 0=alpha, 1=add, 2=subtract, 3=multiply, 4=screen
  layerOpacity0  : f32,  // opacity for layer 0
  layerOpacity1  : f32,  // opacity for layer 1
  layerOpacity2  : f32,  // opacity for layer 2
  _pad0          : f32,  // padding
};
@group(0) @binding(5) var<uniform> cu : CompositorUniforms;

fn applyOpacity(color: vec4<f32>, opacity: f32) -> vec4<f32> {
  return vec4<f32>(color.rgb, color.a * opacity);
}

fn alpha_blend(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  let a = src.a + dst.a * (1.0 - src.a);
  if (a < 0.0001) { return vec4<f32>(0.0); }
  let rgb = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / a;
  return vec4<f32>(rgb, a);
}

fn add_blend(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  return dst + src;
}

fn subtract_blend(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  return max(dst - src, vec4<f32>(0.0));
}

fn multiply_blend(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  let rgb = dst.rgb * src.rgb;
  let a = src.a + dst.a * (1.0 - src.a);
  return vec4<f32>(rgb, a);
}

fn screen_blend(dst: vec4<f32>, src: vec4<f32>) -> vec4<f32> {
  let rgb = 1.0 - (1.0 - dst.rgb) * (1.0 - src.rgb);
  let a = src.a + dst.a * (1.0 - src.a);
  return vec4<f32>(rgb, a);
}

fn blend(dst: vec4<f32>, src: vec4<f32>, mode: u32) -> vec4<f32> {
  switch (mode) {
    case 1u: { return add_blend(dst, src); }
    case 2u: { return subtract_blend(dst, src); }
    case 3u: { return multiply_blend(dst, src); }
    case 4u: { return screen_blend(dst, src); }
    default: { return alpha_blend(dst, src); }
  }
}

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c0   = textureSample(layer0,      cSampler, uv);
  let c1   = textureSample(layer1,      cSampler, uv);
  let c2   = textureSample(layer2,      cSampler, uv);
  let pers = textureSample(persistence, cSampler, uv);

  let persScaled = vec4<f32>(pers.rgb, pers.a * cu.tracerOpacity);

  // Apply per-layer opacity before compositing
  let c0Opaque = applyOpacity(c0, cu.layerOpacity0);
  let c1Opaque = applyOpacity(c1, cu.layerOpacity1);
  let c2Opaque = applyOpacity(c2, cu.layerOpacity2);

  var col = vec4<f32>(0.0);
  if (cu.tracerBelow > 0.5) {
    // Tracer below — layers render on top of ghosts
    col = blend(col, persScaled, cu.tracerBlendMode);
    col = blend(col, c2Opaque, cu.layerBlendMode);
    col = blend(col, c1Opaque, cu.layerBlendMode);
    col = blend(col, c0Opaque, cu.layerBlendMode);
  } else {
    // Tracer above — ghosts render on top of layers (default)
    col = blend(col, c2Opaque, cu.layerBlendMode);
    col = blend(col, c1Opaque, cu.layerBlendMode);
    col = blend(col, c0Opaque, cu.layerBlendMode);
    col = blend(col, persScaled, cu.tracerBlendMode);
  }

  return col;
}
`;

// Keep old names as aliases so nothing else breaks during transition
export const compositorVertexSource = fullscreenVertexSource;
