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
