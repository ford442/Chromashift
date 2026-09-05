import { BAND_THRESHOLDS } from '../../math/bandClassification';

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
 * Tracer overlap ("coincidence") detection — the per-pixel math that used to
 * be duplicated inside the fused persistence fragment shader (once per
 * above/below decay pass, with identical inputs both times). Computed once
 * here into two storage textures; the lighter composite fragment pass reads
 * them for the above/below decay draws. Mirrors `computeCoincidence()` in
 * `src/engine/math/coincidence.ts` — see `coincidence.test.ts` for the
 * golden parity check.
 *
 * Bit-packing note: `stamp_tex.b` doubles as the "2+ layers overlapping"
 * flag whenever `stamp_tex.a` is 0 (no fresh stamp was painted). This is
 * safe because `stamp.rgb` is otherwise exactly (0,0,0) in that branch, and
 * the composite pass never reads `stamp.rgb` unless `stamp.a` wins the
 * decay/paint comparison.
 */
export const COINCIDENCE_COMPUTE_SHADER = /* wgsl */ `
struct CoincidenceParams {
  width        : u32,
  height       : u32,
  tracer_mode  : u32,
  _pad0        : u32,
  color_thresh : f32,
  stamp_boost  : f32,
  _pad1        : f32,
  _pad2        : f32,
};

@group(0) @binding(0) var layer0    : texture_2d<f32>;
@group(0) @binding(1) var layer1    : texture_2d<f32>;
@group(0) @binding(2) var layer2    : texture_2d<f32>;
@group(0) @binding(3) var stamp_tex : texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var diag_tex  : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<uniform> params : CoincidenceParams;

@compute @workgroup_size(8, 8)
fn coincidence_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let coord = vec2<i32>(gid.xy);
  let c0 = textureLoad(layer0, coord, 0);
  let c1 = textureLoad(layer1, coord, 0);
  let c2 = textureLoad(layer2, coord, 0);

  let thresh = params.color_thresh;
  var layer_count = 0u;
  if (c0.a > thresh) { layer_count = layer_count + 1u; }
  if (c1.a > thresh) { layer_count = layer_count + 1u; }
  if (c2.a > thresh) { layer_count = layer_count + 1u; }

  var new_color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var diag = vec4<f32>(0.0, 0.0, 0.0, 0.0);

  if (layer_count >= 2u) {
    var sum = vec3<f32>(0.0);
    if (c0.a > thresh) { sum = sum + c0.rgb; }
    if (c1.a > thresh) { sum = sum + c1.rgb; }
    if (c2.a > thresh) { sum = sum + c2.rgb; }
    let combined = sum / f32(layer_count);

    var variance = 0.0;
    if (c0.a > thresh) { variance = variance + length(c0.rgb - combined); }
    if (c1.a > thresh) { variance = variance + length(c1.rgb - combined); }
    if (c2.a > thresh) { variance = variance + length(c2.rgb - combined); }

    if (variance > 0.01) {
      var dominant_layer = 0u;
      var max_lum = 0.0;
      if (c0.a > thresh) {
        let lum = dot(c0.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (lum > max_lum) { max_lum = lum; dominant_layer = 0u; }
      }
      if (c1.a > thresh) {
        let lum = dot(c1.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (lum > max_lum) { max_lum = lum; dominant_layer = 1u; }
      }
      if (c2.a > thresh) {
        let lum = dot(c2.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (lum > max_lum) { max_lum = lum; dominant_layer = 2u; }
      }

      if (params.tracer_mode == 1u) {
        let lum = dot(combined, vec3<f32>(0.2126, 0.7152, 0.0722));
        let boosted = min(lum * params.stamp_boost, 1.0);
        new_color = vec4<f32>(vec3<f32>(boosted), 1.0);
      } else {
        let brightened = min(combined * params.stamp_boost, vec3<f32>(1.0));
        new_color = vec4<f32>(brightened, 1.0);
      }

      diag.r = f32(dominant_layer) / 2.0;
      diag.g = select(0.5, 1.0, layer_count >= 3u);
      diag.b = clamp(variance * 10.0, 0.0, 1.0);
      diag.a = 1.0;
    } else {
      // Overlap present but every active layer is the same colour: no fresh
      // stamp, but the composite pass must still decay at the faster rate.
      new_color.b = 1.0;
    }
  }

  textureStore(stamp_tex, coord, new_color);
  textureStore(diag_tex, coord, diag);
}
`;
