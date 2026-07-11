import { BAND_THRESHOLDS } from '../math/bandClassification';

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
