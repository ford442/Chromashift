/**
 * WGSL shaders for the Chromashift 3-layer WebGPU rendering pipeline.
 *
 * Each layer renders a full-screen quad and applies:
 *  - a mat3 rotation transform in the vertex stage
 *  - a colour-channel mask (Red/Orange | Violet/Blue | Green/Yellow) in the fragment stage
 */

export const vertexShaderSource = /* wgsl */ `
struct Uniforms {
  rotation : mat3x3<f32>,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn main(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  // Full-screen triangle (covers the viewport with 3 vertices)
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );

  let clipPos = positions[vertexIndex];

  // Apply mat3 rotation (z-rotation) to the clip-space position
  let rotated = uniforms.rotation * vec3<f32>(clipPos, 1.0);

  var out : VertexOutput;
  out.position = vec4<f32>(rotated.xy, 0.0, 1.0);
  // UV: map [-1,1] -> [0,1]
  out.uv = clipPos * 0.5 + 0.5;
  return out;
}
`;

/**
 * Fragment shader for layer 0 – Red / Orange channel mask.
 * Pixels in the Red/Orange luminance band are passed through;
 * all others become transparent.
 */
export const fragmentShaderRedOrange = /* wgsl */ `
@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex : texture_2d<f32>;

struct FragUniforms {
  avgLuminance : f32,
  _pad0 : f32,
  _pad1 : f32,
  _pad2 : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let sample = textureSample(tex, texSampler, uv);
  let lum = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;

  let avg = fragUniforms.avgLuminance;
  let diff = (avg / 255.0) * 32.0;

  // Red / Orange band: lum > 193
  if (lum > 229.0) {
    // past orange -> near white highlight
    let v = (avg + (lum - 229.0)) / 255.0;
    return vec4<f32>(v, v, v, 1.0);
  } else if (lum > 209.0) {
    // orange
    return vec4<f32>(1.0, (128.0 - diff) / 255.0, 0.0, 1.0);
  } else if (lum > 190.0) {
    // red (193 threshold with 190 border)
    return vec4<f32>((255.0 - diff) / 255.0, 0.0, 0.0, 1.0);
  }

  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;

/**
 * Fragment shader for layer 1 – Violet / Blue channel mask.
 */
export const fragmentShaderVioletBlue = /* wgsl */ `
@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex : texture_2d<f32>;

struct FragUniforms {
  avgLuminance : f32,
  _pad0 : f32,
  _pad1 : f32,
  _pad2 : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let sample = textureSample(tex, texSampler, uv);
  let lum = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;

  let avg = fragUniforms.avgLuminance;
  let diff = (avg / 255.0) * 32.0;

  // Violet / Blue band: 158 < lum <= 190
  if (lum > 177.0 && lum <= 190.0) {
    // violet
    return vec4<f32>((128.0 - diff) / 255.0, 0.0, 1.0, 1.0);
  } else if (lum > 158.0 && lum <= 177.0) {
    // blue
    return vec4<f32>(0.0, 0.0, (255.0 - diff) / 255.0, 1.0);
  }

  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;

/**
 * Fragment shader for layer 2 – Green / Yellow channel mask.
 */
export const fragmentShaderGreenYellow = /* wgsl */ `
@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex : texture_2d<f32>;

struct FragUniforms {
  avgLuminance : f32,
  _pad0 : f32,
  _pad1 : f32,
  _pad2 : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let sample = textureSample(tex, texSampler, uv);
  let lum = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;

  let avg = fragUniforms.avgLuminance;
  let diff = (avg / 255.0) * 32.0;

  // Green / Yellow band: 125 < lum <= 158
  if (lum > 145.0 && lum <= 158.0) {
    // green
    return vec4<f32>(0.0, (255.0 - diff) / 255.0, 0.0, 1.0);
  } else if (lum > 125.0 && lum <= 145.0) {
    // yellow
    return vec4<f32>(1.0, (255.0 - diff) / 255.0, 0.0, 1.0);
  }

  return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}
`;
