import { WGSL_BLEND_HELPERS } from './common';

// ─── Compositor fragment shader ─────────────────────────────────────────────────────────────────────
//
// Blends the "Below" persistence texture, then the 3 live layers,
// then the "Above" persistence texture on top.
//
export const compositorFragmentSource = /* wgsl */ `
${WGSL_BLEND_HELPERS}

@group(0) @binding(0) var cSampler       : sampler;
@group(0) @binding(1) var layer0         : texture_2d<f32>;
@group(0) @binding(2) var layer1         : texture_2d<f32>;
@group(0) @binding(3) var layer2         : texture_2d<f32>;
@group(0) @binding(4) var persistBelow   : texture_2d<f32>;
@group(0) @binding(5) var persistAbove   : texture_2d<f32>;

struct CompositorUniforms {
  tracerAboveOpacity : f32,
  tracerBelowOpacity : f32,
  layerBlendMode     : u32,
  tracerBlendMode    : u32,
  layerOpacity0      : f32,
  layerOpacity1      : f32,
  layerOpacity2      : f32,
  diagnosticsOpacity : f32,
  stampBoost         : f32,
  outputMode         : u32,
  tracerMode         : u32,
  diagnosticsMode    : u32,
  viewportQuarterZoom: u32,
  halfOverlayAlpha   : f32,
  viewportHalfOverlay: u32,
};
@group(0) @binding(6) var<uniform> cu : CompositorUniforms;

fn viewportSampleUV(uv: vec2<f32>) -> vec2<f32> {
  if (cu.viewportQuarterZoom == 0u) {
    return uv;
  }
  // Magnify the bottom-left quarter (x: 0–0.5, y: 0.5–1.0) to fill the canvas.
  return vec2<f32>(uv.x * 0.5, uv.y * 0.5 + 0.5);
}

fn compositeAt(sampleUV: vec2<f32>) -> vec4<f32> {
  let c0      = textureSample(layer0,       cSampler, sampleUV);
  let c1      = textureSample(layer1,       cSampler, sampleUV);
  let c2      = textureSample(layer2,       cSampler, sampleUV);
  let pBelow  = textureSample(persistBelow, cSampler, sampleUV);
  let pAbove  = textureSample(persistAbove, cSampler, sampleUV);

  let pBelowScaled = scale_premultiplied(pBelow, cu.tracerBelowOpacity);
  let pAboveScaled = scale_premultiplied(pAbove, cu.tracerAboveOpacity);

  let c0Opaque = scale_premultiplied(c0, cu.layerOpacity0);
  let c1Opaque = scale_premultiplied(c1, cu.layerOpacity1);
  let c2Opaque = scale_premultiplied(c2, cu.layerOpacity2);

  // 1. Blend the main active layers together
  var layerCol = vec4<f32>(0.0);
  layerCol = blend(layerCol, c2Opaque, cu.layerBlendMode);
  layerCol = blend(layerCol, c1Opaque, cu.layerBlendMode);
  layerCol = blend(layerCol, c0Opaque, cu.layerBlendMode);

  let thresh = 0.05;
  var layerCount = 0u;
  if (c0Opaque.a > thresh) { layerCount = layerCount + 1u; }
  if (c1Opaque.a > thresh) { layerCount = layerCount + 1u; }
  if (c2Opaque.a > thresh) { layerCount = layerCount + 1u; }

  var stamp = vec4<f32>(0.0);
  if (layerCount >= 2u) {
    var sum = vec3<f32>(0.0);
    if (c0Opaque.a > thresh) { sum = sum + c0Opaque.rgb; }
    if (c1Opaque.a > thresh) { sum = sum + c1Opaque.rgb; }
    if (c2Opaque.a > thresh) { sum = sum + c2Opaque.rgb; }
    let combined = sum / f32(layerCount);

    var variance = 0.0;
    if (c0Opaque.a > thresh) { variance = variance + length(c0Opaque.rgb - combined); }
    if (c1Opaque.a > thresh) { variance = variance + length(c1Opaque.rgb - combined); }
    if (c2Opaque.a > thresh) { variance = variance + length(c2Opaque.rgb - combined); }

    if (variance > 0.01) {
      if (cu.tracerMode == 1u) {
        let lum = dot(combined, vec3<f32>(0.2126, 0.7152, 0.0722));
        let boosted = min(lum * cu.stampBoost, 1.0);
        stamp = vec4<f32>(vec3<f32>(boosted), 1.0);
      } else {
        let brightened = min(combined * cu.stampBoost, vec3<f32>(1.0));
        stamp = vec4<f32>(brightened, 1.0);
      }
    }
  }

  // 2. Build the final depth stack based on output mode
  var finalCol = vec4<f32>(0.0);

  if (cu.outputMode == 1u) {
    // Tracer Focus: layers first, then both tracers on top
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pBelowScaled, cu.tracerBlendMode);
    finalCol = blend(finalCol, pAboveScaled, cu.tracerBlendMode);
  } else if (cu.outputMode == 2u) {
    // Tracer Only: suppress live layers
    finalCol = blend(finalCol, pBelowScaled, cu.tracerBlendMode);
    finalCol = blend(finalCol, pAboveScaled, cu.tracerBlendMode);
  } else if (cu.outputMode == 3u) {
    finalCol = stamp;
  } else {
    // Mixed (default): Below -> Layers -> Above
    finalCol = blend(finalCol, pBelowScaled, cu.tracerBlendMode);
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pAboveScaled, cu.tracerBlendMode);
  }

  // Force opaque output. Without this, no-layer / no-tracer regions produce
  // alpha=0 pixels and some browser/GPU combos let the OS compositor see
  // through the canvas even though alphaMode is 'opaque' on the swapchain.
  // Subtle filmic tonemapping + gentle exposure lift. The pipeline works in
  // 16-bit float, but the swapchain is 8 bpc — a cheap tonemap here
  // distributes energy better across quantisation steps, reducing banding.
  let x = finalCol.rgb * 1.04;                // tiny exposure bias
  var tonemapped = x / (x + vec3<f32>(0.15)); // very soft Reinhard variant
  if (cu.diagnosticsMode == 1u) {
    let diagBase = vec3<f32>(
      clamp(c0Opaque.a, 0.0, 1.0),
      clamp(c1Opaque.a, 0.0, 1.0),
      clamp(c2Opaque.a, 0.0, 1.0)
    );
    var collisionTint = vec3<f32>(0.0);
    if (layerCount == 2u) {
      collisionTint = vec3<f32>(1.0, 0.82, 0.18);
    } else if (layerCount >= 3u) {
      collisionTint = vec3<f32>(1.0, 1.0, 1.0);
    }
    let diagOverlay = max(diagBase, collisionTint * stamp.a);
    tonemapped = mix(tonemapped, diagOverlay, clamp(cu.diagnosticsOpacity, 0.0, 1.0));
  }
  return vec4<f32>(tonemapped, 1.0);
}

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let zoomedCol = compositeAt(viewportSampleUV(uv));
  if (cu.viewportHalfOverlay == 1u) {
    // 1:1 half-height overlay: top and bottom source halves blend in the upper
    // half of the canvas without vertical stretching. Avoid branching on uv
    // before textureSample — use step() to mask the lower half instead.
    let topCol = compositeAt(vec2<f32>(uv.x, uv.y));
    let bottomCol = compositeAt(vec2<f32>(uv.x, uv.y + 0.5));
    let alpha = clamp(cu.halfOverlayAlpha, 0.0, 1.0);
    let overlayRgb = mix(topCol.rgb, bottomCol.rgb, alpha);
    let inUpperHalf = step(uv.y, 0.5);
    return vec4<f32>(overlayRgb * inUpperHalf, 1.0);
  }
  return zoomedCol;
}
`;
