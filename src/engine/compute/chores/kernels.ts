import { BAND_THRESHOLDS } from '../../math/bandClassification';
import { CANONICAL_LAYER_COUNT } from '../../graph/layerSpecs';
import { emitCoincidenceComputeWgsl } from '../../graph/templates/wgsl';

/**
 * Shared WGSL snippets for image-analysis compute passes.
 * The classify_band threshold chain is generated from BAND_THRESHOLDS in
 * src/engine/math/bandClassification.ts, which chromashift_engine.cpp
 * classifyPixel mirrors.
 */
const CLASSIFY_BAND_THRESHOLD_CHAIN = BAND_THRESHOLDS
  .map((t, i) => `  if (rgb > ${t.toFixed(1)}) { return ${i}u; }`)
  .join('\n');

export const WGSL_IMAGE_ANALYSIS_HELPERS = /* wgsl */ `
fn linear_to_stored_u8(channel: f32) -> f32 {
  let c = clamp(channel, 0.0, 1.0);
  if (c <= 0.0031308) {
    return c * 12.92 * 255.0;
  }
  return (1.055 * pow(c, 1.0 / 2.4) - 0.055) * 255.0;
}

fn stored_rgb_u8(texel: vec4<f32>, is_srgb: bool) -> vec3<f32> {
  if (!is_srgb) {
    return texel.rgb * 255.0;
  }
  return vec3<f32>(
    linear_to_stored_u8(texel.r),
    linear_to_stored_u8(texel.g),
    linear_to_stored_u8(texel.b),
  );
}

fn bt709_lum_u8(r: f32, g: f32, b: f32) -> u32 {
  let lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
  return u32(clamp(lum, 0.0, 255.0));
}

fn classify_band(r: f32, g: f32, b: f32, avg_lum: f32) -> u32 {
  let lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let light_dark = 128.0 + abs(avg_lum - 128.0) / 2.0;
  let rgb = lum + light_dark / 2.0;
${CLASSIFY_BAND_THRESHOLD_CHAIN}
  return ${BAND_THRESHOLDS.length}u;
}
`;

export const HISTOGRAM_COMPUTE_SHADER = /* wgsl */ `
${WGSL_IMAGE_ANALYSIS_HELPERS}

struct HistogramParams {
  width: u32,
  height: u32,
  is_srgb: u32,
  _pad: u32,
};

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>, 256>;
@group(0) @binding(2) var<uniform> hist_params: HistogramParams;

@compute @workgroup_size(8, 8)
fn histogram_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= hist_params.width || gid.y >= hist_params.height) {
    return;
  }
  let texel = textureLoad(src_tex, vec2<i32>(gid.xy), 0);
  let rgb = stored_rgb_u8(texel, hist_params.is_srgb != 0u);
  let bucket = bt709_lum_u8(rgb.r, rgb.g, rgb.b);
  atomicAdd(&histogram[bucket], 1u);
}
`;

export const CLASSIFICATION_COMPUTE_SHADER = /* wgsl */ `
${WGSL_IMAGE_ANALYSIS_HELPERS}

struct MaskParams {
  width: u32,
  height: u32,
  is_srgb: u32,
  _pad: u32,
  avg_lum: f32,
  _pad2: f32,
  _pad3: f32,
  _pad4: f32,
};

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var mask_tex: texture_storage_2d<r8uint, write>;
@group(0) @binding(2) var<uniform> mask_params: MaskParams;

@compute @workgroup_size(8, 8)
fn classification_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= mask_params.width || gid.y >= mask_params.height) {
    return;
  }
  let texel = textureLoad(src_tex, vec2<i32>(gid.xy), 0);
  let rgb = stored_rgb_u8(texel, mask_params.is_srgb != 0u);
  let rounded_avg = round(mask_params.avg_lum);
  let band = classify_band(rgb.r, rgb.g, rgb.b, rounded_avg);
  textureStore(mask_tex, vec2<i32>(gid.xy), vec4<u32>(band, 0u, 0u, 0u));
}
`;

/**
 * Tracer overlap ("coincidence") detection for the default layer count.
 *
 * The per-pixel math used to be duplicated inside the fused persistence
 * fragment shader (once per above/below decay pass, with identical inputs both
 * times). It is computed once here into two storage textures; the lighter
 * composite fragment pass reads them for the above/below decay draws.
 *
 * Emitted, not hand-written: {@link emitCoincidenceComputeWgsl} unrolls the
 * same overlap test the fragment path emits, so a session with a different
 * layer count gets a matching kernel instead of this one plus a `TODO`. The
 * text this used to be is kept verbatim as `__golden__/coincidence-compute.wgsl`
 * and `shaderParity.test.ts` holds the three-layer emission to it. Mirrors
 * `computeCoincidence()` in `src/engine/math/coincidence.ts` — see
 * `coincidence.test.ts` for the golden parity check.
 */
export const COINCIDENCE_COMPUTE_SHADER = emitCoincidenceComputeWgsl(CANONICAL_LAYER_COUNT);

/**
 * Quarter-resolution frame-difference motion field.
 *
 * Mirrors `motionKernel.ts` (the `ts` lane's portable implementation): box
 * average BT.709 luminance over each `divisor`×`divisor` block, difference it
 * against the previous frame's luminance for the same cell, subtract the noise
 * floor and rescale the remainder.
 *
 * The previous-frame luminance lives in a pair of ping-ponged `r32float`
 * storage textures owned by the lane, so the caller never has to keep a
 * full-resolution copy of the last frame alive — the history is one float per
 * *cell*, which at the default divisor is 1/16 of a plane.
 *
 * `motion_stats` accumulates the only numbers that may ever cross back to the
 * CPU: a summed magnitude, a moving-cell count, and a cell total. The field
 * itself stays a `GPUTexture`.
 */
export const MOTION_FIELD_COMPUTE_SHADER = /* wgsl */ `
${WGSL_IMAGE_ANALYSIS_HELPERS}

struct MotionParams {
  src_width    : u32,
  src_height   : u32,
  field_width  : u32,
  field_height : u32,
  divisor      : u32,
  reset        : u32,
  is_srgb      : u32,
  threshold    : f32,
};

struct MotionStats {
  // Magnitude is in [0,1]; scaling by 1000 before the atomic keeps three
  // decimal places without needing float atomics (not in WebGPU core).
  sum_milli : atomic<u32>,
  moving    : atomic<u32>,
  cells     : atomic<u32>,
  _pad      : u32,
};

@group(0) @binding(0) var src_tex       : texture_2d<f32>;
@group(0) @binding(1) var prev_lum_tex  : texture_2d<f32>;
@group(0) @binding(2) var field_tex     : texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var next_lum_tex  : texture_storage_2d<r32float, write>;
@group(0) @binding(4) var<storage, read_write> motion_stats : MotionStats;
@group(0) @binding(5) var<uniform> mp : MotionParams;

@compute @workgroup_size(8, 8)
fn motion_field_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= mp.field_width || gid.y >= mp.field_height) {
    return;
  }

  let base = vec2<i32>(i32(gid.x * mp.divisor), i32(gid.y * mp.divisor));
  var sum = 0.0;
  var count = 0.0;
  for (var dy = 0u; dy < mp.divisor; dy = dy + 1u) {
    for (var dx = 0u; dx < mp.divisor; dx = dx + 1u) {
      let coord = base + vec2<i32>(i32(dx), i32(dy));
      if (coord.x < i32(mp.src_width) && coord.y < i32(mp.src_height)) {
        let texel = textureLoad(src_tex, coord, 0);
        let rgb = stored_rgb_u8(texel, mp.is_srgb != 0u) / 255.0;
        sum = sum + dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        count = count + 1.0;
      }
    }
  }
  let lum = select(0.0, sum / max(count, 1.0), count > 0.0);

  let cell = vec2<i32>(gid.xy);
  let prev = textureLoad(prev_lum_tex, cell, 0).r;

  var magnitude = 0.0;
  if (mp.reset == 0u) {
    let floor_value = clamp(mp.threshold, 0.0, 0.999);
    let delta = abs(lum - prev);
    if (delta > floor_value) {
      magnitude = min((delta - floor_value) / max(1.0 - floor_value, 1e-4), 1.0);
    }
  }

  // gb are reserved for the flow vector a block-matching / Lucas-Kanade stage
  // would write; the frame-difference stage leaves them zero, which the
  // persistence shader's \`direction\` mode reads as "no direction known yet".
  textureStore(field_tex, cell, vec4<f32>(magnitude, 0.0, 0.0, 1.0));
  textureStore(next_lum_tex, cell, vec4<f32>(lum, 0.0, 0.0, 1.0));

  atomicAdd(&motion_stats.sum_milli, u32(magnitude * 1000.0));
  atomicAdd(&motion_stats.moving, select(0u, 1u, magnitude > 0.0));
  atomicAdd(&motion_stats.cells, 1u);
}
`;
