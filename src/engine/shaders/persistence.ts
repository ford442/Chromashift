// ─── Persistence fragment shader ─────────────────────────────────────────────────────
//
// Accumulates layer overlaps (collisions) over time with configurable decay.
// When layers overlap, we capture the blended color.
// When they don't overlap, we decay the previous persistence.
//
// Uniforms layout (std140-ish, WGSL explicit offsets):
//   0: decayFactor (f32) – 0.99 = slow fade, 0.5 = fast fade
//   4: colorThresh  (f32) – minimum alpha to consider a "collision"
//   8: stampBoost   (f32) – boost applied only to fresh collision stamps
//  12: tracerMode   (u32)  – 0 = combined colors, 1 = grey highlight
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
  stampBoost  : f32,
  tracerMode  : u32,
  peakMode    : u32,
  _pad0       : u32,
  _pad1       : u32,
  _pad2       : u32,
};
@group(0) @binding(5) var<uniform> pu : PersistUniforms;

struct FragmentOutputs {
  @location(0) persistence : vec4<f32>,
  @location(1) stampDiagnostic : vec4<f32>,
};

@fragment
fn main(@location(0) uv : vec2<f32>) -> FragmentOutputs {
  let c0 = textureSample(layer0, cSampler, uv);
  let c1 = textureSample(layer1, cSampler, uv);
  let c2 = textureSample(layer2, cSampler, uv);
  let prev = textureSample(prevTex, cSampler, uv);

  // Count how many layers have visible color at this pixel
  var layerCount = 0u;
  let thresh = pu.colorThresh;
  if (c0.a > thresh) { layerCount = layerCount + 1u; }
  if (c1.a > thresh) { layerCount = layerCount + 1u; }
  if (c2.a > thresh) { layerCount = layerCount + 1u; }

  // Default to zero alpha (empty)
  var newColor = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var dominantLayer = 0u;
  var stampVariance = 0.0;

  // Stamp a tracer ghost when 2+ layers overlap (much more likely than all 3).
  // Skip when all active layers are the same colour — this prevents full-image
  // grey tracer accumulation in dark areas where every layer outputs identical grey.
  if (layerCount >= 2u) {
    var sum = vec3<f32>(0.0);
    if (c0.a > thresh) { sum = sum + c0.rgb; }
    if (c1.a > thresh) { sum = sum + c1.rgb; }
    if (c2.a > thresh) { sum = sum + c2.rgb; }
    let combined = sum / f32(layerCount);

    // Measure colour variance among active layers
    var variance = 0.0;
    if (c0.a > thresh) { variance = variance + length(c0.rgb - combined); }
    if (c1.a > thresh) { variance = variance + length(c1.rgb - combined); }
    if (c2.a > thresh) { variance = variance + length(c2.rgb - combined); }
    stampVariance = variance;

    if (variance > 0.01) {
      // Determine which layer contributed most to the combined colour
      var maxLum = 0.0;
      if (c0.a > thresh) {
        let lum = dot(c0.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (lum > maxLum) { maxLum = lum; dominantLayer = 0u; }
      }
      if (c1.a > thresh) {
        let lum = dot(c1.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (lum > maxLum) { maxLum = lum; dominantLayer = 1u; }
      }
      if (c2.a > thresh) {
        let lum = dot(c2.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
        if (lum > maxLum) { maxLum = lum; dominantLayer = 2u; }
      }

      if (pu.tracerMode == 1u) {
        let lum = dot(combined, vec3<f32>(0.2126, 0.7152, 0.0722));
        // Boost grey highlight for visibility
        let boosted = min(lum * pu.stampBoost, 1.0);
        newColor = vec4<f32>(vec3<f32>(boosted), 1.0);
      } else {
        // Brighten the combined color so tracer is visually distinct from raw layers
        let brightened = min(combined * pu.stampBoost, vec3<f32>(1.0));
        newColor = vec4<f32>(brightened, 1.0);
      }
    }
  }

  // Decay modifier: decay faster when actively overlapping, slower otherwise
  let decayMod = select(1.0, 1.5, layerCount >= 2u);
  let effectiveDecay = pow(pu.decayFactor, decayMod);
  var decayed = prev * effectiveDecay;
  if (pu.peakMode == 1u) {
    decayed = vec4<f32>(0.0);
  }

  // Keep the stronger one (new collision beats old ghost)
  let outColor = select(decayed, newColor, newColor.a > decayed.a);

  // Diagnostic output: encode stamp metadata for CPU readback / visualisation
  var diag = vec4<f32>(0.0);
  if (newColor.a > 0.5) {
    diag.r = f32(dominantLayer) / 2.0;
    diag.g = select(0.5, 1.0, layerCount >= 3u);
    diag.b = clamp(stampVariance * 10.0, 0.0, 1.0);
    diag.a = 1.0;
  }

  var out : FragmentOutputs;
  out.persistence = outColor;
  out.stampDiagnostic = diag;
  return out;
}
`;
