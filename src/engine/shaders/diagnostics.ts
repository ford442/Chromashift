import { WGSL_BLEND_HELPERS } from './common';

// ─── Tracer View (centered aspect-fit blit, issues #58/#59/#61) ──────────────
// "Show Full Tracer" inspection path. Previously bypassed the compositor
// entirely, causing mismatched hue/brightness and ignoring user controls.
// Now uses the same blend helpers and Reinhard tonemap, respects
// tracerAboveOpacity/tracerBelowOpacity/tracerBlendMode, and still preserves
// the aspect-fit letterboxing for non-1.0 tracerScale values.
export const tracerViewFragmentSource = /* wgsl */ `
${WGSL_BLEND_HELPERS}

@group(0) @binding(0) var texSampler  : sampler;
@group(0) @binding(1) var persistAbove: texture_2d<f32>;
@group(0) @binding(2) var persistBelow: texture_2d<f32>;
@group(0) @binding(3) var layer0      : texture_2d<f32>;
@group(0) @binding(4) var layer1      : texture_2d<f32>;
@group(0) @binding(5) var layer2      : texture_2d<f32>;

struct TracerViewUniforms {
  canvasAspect       : f32,
  texAspect          : f32,
  tracerAboveOpacity : f32,
  tracerBelowOpacity : f32,
  tracerBlendMode    : u32,
  showHeatmap        : u32,
  zoom               : f32,
  panX               : f32,
  panY               : f32,
  heatmapOpacity     : f32,
  exposure           : f32,
  applyTonemap       : u32,
  showLayers         : u32,
  layerBlendMode     : u32,
  layerOpacity0      : f32,
  layerOpacity1      : f32,
  layerOpacity2      : f32,
};
@group(0) @binding(6) var<uniform> tvu : TracerViewUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  // Aspect-fit letterboxing so tracerScale != 1.0 still looks correct.
  let cA = tvu.canvasAspect;
  let tA = tvu.texAspect;

  var sampleUV = uv;
  if (cA > tA + 0.0001) {
    let visW = tA / cA;
    let x0 = (1.0 - visW) * 0.5;
    if (uv.x < x0 || uv.x > x0 + visW) {
      return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    sampleUV.x = (uv.x - x0) / visW;
  } else if (tA > cA + 0.0001) {
    let visH = cA / tA;
    let y0 = (1.0 - visH) * 0.5;
    if (uv.y < y0 || uv.y > y0 + visH) {
      return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    sampleUV.y = (uv.y - y0) / visH;
  }

  let zoom = max(tvu.zoom, 1.0);
  sampleUV = (sampleUV - vec2<f32>(0.5, 0.5)) / zoom + vec2<f32>(0.5 + tvu.panX, 0.5 + tvu.panY);
  if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let pAbove = textureSampleLevel(persistAbove, texSampler, sampleUV, 0.0);
  let pBelow = textureSampleLevel(persistBelow, texSampler, sampleUV, 0.0);

  let pAboveScaled = scale_premultiplied(pAbove, tvu.tracerAboveOpacity);
  let pBelowScaled = scale_premultiplied(pBelow, tvu.tracerBelowOpacity);

  var col = vec4<f32>(0.0);
  col = blend(col, pBelowScaled, tvu.tracerBlendMode);
  col = blend(col, pAboveScaled, tvu.tracerBlendMode);

  // When showLayers is enabled, composite the live layers on top of the
  // tracers using the same layerBlendMode the main compositor uses.
  // This makes the tracer inspector match the artistic output as closely
  // as possible (modulo stampBoost and diagnostics overlays).
  if (tvu.showLayers == 1u) {
    let c0 = textureSampleLevel(layer0, texSampler, sampleUV, 0.0);
    let c1 = textureSampleLevel(layer1, texSampler, sampleUV, 0.0);
    let c2 = textureSampleLevel(layer2, texSampler, sampleUV, 0.0);
    let c0s = scale_premultiplied(c0, tvu.layerOpacity0);
    let c1s = scale_premultiplied(c1, tvu.layerOpacity1);
    let c2s = scale_premultiplied(c2, tvu.layerOpacity2);
    col = blend(col, c2s, tvu.layerBlendMode);
    col = blend(col, c1s, tvu.layerBlendMode);
    col = blend(col, c0s, tvu.layerBlendMode);
  }

  if (tvu.showHeatmap == 1u) {
    let c0 = textureSampleLevel(layer0, texSampler, sampleUV, 0.0);
    let c1 = textureSampleLevel(layer1, texSampler, sampleUV, 0.0);
    let c2 = textureSampleLevel(layer2, texSampler, sampleUV, 0.0);
    var count = 0u;
    if (c0.a > 0.05) { count = count + 1u; }
    if (c1.a > 0.05) { count = count + 1u; }
    if (c2.a > 0.05) { count = count + 1u; }
    var overlay = vec3<f32>(0.0);
    if (count == 2u) {
      overlay = vec3<f32>(1.0, 0.92, 0.18);
    } else if (count >= 3u) {
      overlay = vec3<f32>(1.0, 1.0, 1.0);
    }
    col.rgb = max(col.rgb, mix(col.rgb, overlay, tvu.heatmapOpacity));
  }

  // Apply the same exposure + Reinhard tonemap as the compositor.
  // exposure defaults to 1.04 and can be adjusted in the inspector controls.
  if (tvu.applyTonemap == 1u) {
    let x = col.rgb * tvu.exposure;
    let tonemapped = x / (x + vec3<f32>(0.15));
    return vec4<f32>(tonemapped, 1.0);
  }
  return vec4<f32>(col.rgb, 1.0);
}
`;

export const displayTextureFragmentSource = /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var tex        : texture_2d<f32>;

struct DisplayUniforms {
  canvasAspect : f32,
  texAspect    : f32,
  tonemap      : u32,
  _pad0        : u32,
};
@group(0) @binding(2) var<uniform> du : DisplayUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  var sampleUV = uv;
  if (du.canvasAspect > du.texAspect + 0.0001) {
    let visW = du.texAspect / du.canvasAspect;
    let x0 = (1.0 - visW) * 0.5;
    if (uv.x < x0 || uv.x > x0 + visW) {
      return vec4<f32>(0.02, 0.02, 0.03, 1.0);
    }
    sampleUV.x = (uv.x - x0) / visW;
  } else if (du.texAspect > du.canvasAspect + 0.0001) {
    let visH = du.canvasAspect / du.texAspect;
    let y0 = (1.0 - visH) * 0.5;
    if (uv.y < y0 || uv.y > y0 + visH) {
      return vec4<f32>(0.02, 0.02, 0.03, 1.0);
    }
    sampleUV.y = (uv.y - y0) / visH;
  }

  let sampleColor = textureSampleLevel(tex, texSampler, sampleUV, 0.0);
  if (du.tonemap == 0u) {
    return vec4<f32>(sampleColor.rgb, 1.0);
  }

  let x = sampleColor.rgb * 1.04;
  let tonemapped = x / (x + vec3<f32>(0.15));
  return vec4<f32>(tonemapped, 1.0);
}
`;

export const coincidenceHeatmapFragmentSource = /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var layer0     : texture_2d<f32>;
@group(0) @binding(2) var layer1     : texture_2d<f32>;
@group(0) @binding(3) var layer2     : texture_2d<f32>;

struct HeatmapUniforms {
  threshold : f32,
  _pad0     : f32,
  _pad1     : u32,
  _pad2     : u32,
};
@group(0) @binding(4) var<uniform> hu : HeatmapUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c0 = textureSample(layer0, texSampler, uv);
  let c1 = textureSample(layer1, texSampler, uv);
  let c2 = textureSample(layer2, texSampler, uv);

  var count = 0u;
  if (c0.a > hu.threshold) { count = count + 1u; }
  if (c1.a > hu.threshold) { count = count + 1u; }
  if (c2.a > hu.threshold) { count = count + 1u; }

  if (count < 2u) {
    let maxBand = max(max(c0.rgb, c1.rgb), c2.rgb) * 0.22;
    return vec4<f32>(maxBand, 1.0);
  }

  let combined = c0.rgb + c1.rgb + c2.rgb;
  if (count == 2u) {
    let warm = normalize(max(combined, vec3<f32>(0.0001))) * vec3<f32>(1.0, 0.9, 0.25);
    return vec4<f32>(warm, 1.0);
  }

  let hot = vec3<f32>(1.0, 0.98, 0.98) + combined * 0.15;
  return vec4<f32>(min(hot, vec3<f32>(1.0)), 1.0);
}
`;

export const diagnosticFragmentSource = /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var layer0     : texture_2d<f32>;
@group(0) @binding(2) var layer1     : texture_2d<f32>;
@group(0) @binding(3) var layer2     : texture_2d<f32>;

struct DiagnosticUniforms {
  threshold : f32,
  opacity0  : f32,
  opacity1  : f32,
  opacity2  : f32,
};
@group(0) @binding(4) var<uniform> du : DiagnosticUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let c0 = textureSample(layer0, texSampler, uv);
  let c1 = textureSample(layer1, texSampler, uv);
  let c2 = textureSample(layer2, texSampler, uv);

  let a0 = c0.a * du.opacity0;
  let a1 = c1.a * du.opacity1;
  let a2 = c2.a * du.opacity2;

  var count = 0u;
  if (a0 > du.threshold) { count = count + 1u; }
  if (a1 > du.threshold) { count = count + 1u; }
  if (a2 > du.threshold) { count = count + 1u; }

  let collision = select(0.0, select(0.67, 1.0, count >= 3u), count >= 2u);
  return vec4<f32>(clamp(vec3<f32>(a0, a1, a2), vec3<f32>(0.0), vec3<f32>(1.0)), collision);
}
`;

export const persistDiagnosticBlitFragmentSource = /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var diagTex    : texture_2d<f32>;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(diagTex, texSampler, uv);
}
`;

export const stampDiagnosticViewFragmentSource = /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var diagTex    : texture_2d<f32>;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let d = textureSample(diagTex, texSampler, uv);
  if (d.a < 0.5) {
    return vec4<f32>(0.02, 0.02, 0.03, 1.0);
  }

  var color = vec3<f32>(0.0);
  if (d.r < 0.33) {
    color = vec3<f32>(1.0, 0.0, 0.0);       // Layer 0 — Red
  } else if (d.r < 0.66) {
    color = vec3<f32>(0.5, 0.0, 1.0);       // Layer 1 — Violet
  } else {
    color = vec3<f32>(0.0, 1.0, 0.0);       // Layer 2 — Green
  }

  let intensity = 0.3 + 0.7 * d.b;
  return vec4<f32>(color * intensity, 1.0);
}
`;

export const compareFragmentSource = /* wgsl */ `
${WGSL_BLEND_HELPERS}

@group(0) @binding(0) var cSampler       : sampler;
@group(0) @binding(1) var sourceTex      : texture_2d<f32>;
@group(0) @binding(2) var layer0         : texture_2d<f32>;
@group(0) @binding(3) var layer1         : texture_2d<f32>;
@group(0) @binding(4) var layer2         : texture_2d<f32>;
@group(0) @binding(5) var persistBelow   : texture_2d<f32>;
@group(0) @binding(6) var persistAbove   : texture_2d<f32>;

struct CompareUniforms {
  sourceAspect       : f32,
  tracerAboveOpacity : f32,
  tracerBelowOpacity : f32,
  layerBlendMode     : u32,
  tracerBlendMode    : u32,
  layerOpacity0      : f32,
  layerOpacity1      : f32,
  layerOpacity2      : f32,
  stampBoost         : f32,
  dividerWidth       : f32,
  outputMode         : u32,
  tracerMode         : u32,
};
@group(0) @binding(7) var<uniform> cu : CompareUniforms;

fn compositeAt(uv : vec2<f32>) -> vec3<f32> {
  let c0 = scale_premultiplied(textureSampleLevel(layer0, cSampler, uv, 0.0), cu.layerOpacity0);
  let c1 = scale_premultiplied(textureSampleLevel(layer1, cSampler, uv, 0.0), cu.layerOpacity1);
  let c2 = scale_premultiplied(textureSampleLevel(layer2, cSampler, uv, 0.0), cu.layerOpacity2);
  let pBelow = scale_premultiplied(textureSampleLevel(persistBelow, cSampler, uv, 0.0), cu.tracerBelowOpacity);
  let pAbove = scale_premultiplied(textureSampleLevel(persistAbove, cSampler, uv, 0.0), cu.tracerAboveOpacity);

  var layerCol = vec4<f32>(0.0);
  layerCol = blend(layerCol, c2, cu.layerBlendMode);
  layerCol = blend(layerCol, c1, cu.layerBlendMode);
  layerCol = blend(layerCol, c0, cu.layerBlendMode);

  var finalCol = vec4<f32>(0.0);
  if (cu.outputMode == 1u) {
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pBelow, cu.tracerBlendMode);
    finalCol = blend(finalCol, pAbove, cu.tracerBlendMode);
  } else if (cu.outputMode == 2u) {
    finalCol = blend(finalCol, pBelow, cu.tracerBlendMode);
    finalCol = blend(finalCol, pAbove, cu.tracerBlendMode);
  } else if (cu.outputMode == 3u) {
    let thresh = 0.05;
    var layerCount = 0u;
    if (c0.a > thresh) { layerCount = layerCount + 1u; }
    if (c1.a > thresh) { layerCount = layerCount + 1u; }
    if (c2.a > thresh) { layerCount = layerCount + 1u; }
    if (layerCount >= 2u) {
      var sum = vec3<f32>(0.0);
      if (c0.a > thresh) { sum = sum + c0.rgb; }
      if (c1.a > thresh) { sum = sum + c1.rgb; }
      if (c2.a > thresh) { sum = sum + c2.rgb; }
      let combined = sum / f32(layerCount);
      if (cu.tracerMode == 1u) {
        let lum = dot(combined, vec3<f32>(0.2126, 0.7152, 0.0722));
        finalCol = vec4<f32>(vec3<f32>(min(lum * cu.stampBoost, 1.0)), 1.0);
      } else {
        finalCol = vec4<f32>(min(combined * cu.stampBoost, vec3<f32>(1.0)), 1.0);
      }
    }
  } else {
    finalCol = blend(finalCol, pBelow, cu.tracerBlendMode);
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pAbove, cu.tracerBlendMode);
  }

  let x = finalCol.rgb * 1.04;
  return x / (x + vec3<f32>(0.15));
}

fn sampleSourceFitted(uv : vec2<f32>) -> vec3<f32> {
  let halfAspect = 0.5 * cu.sourceAspect;
  var sampleUV = vec2<f32>(uv.x * 2.0, uv.y);

  if (halfAspect > 1.0 + 0.0001) {
    let visH = 1.0 / halfAspect;
    let y0 = (1.0 - visH) * 0.5;
    if (uv.y < y0 || uv.y > y0 + visH) {
      return vec3<f32>(0.02, 0.02, 0.03);
    }
    sampleUV.y = (uv.y - y0) / visH;
  } else if (1.0 > halfAspect + 0.0001) {
    let visW = halfAspect;
    let x0 = (1.0 - visW) * 0.5;
    let localX = uv.x * 2.0;
    if (localX < x0 || localX > x0 + visW) {
      return vec3<f32>(0.02, 0.02, 0.03);
    }
    sampleUV.x = (localX - x0) / visW;
  }

  return textureSampleLevel(sourceTex, cSampler, sampleUV, 0.0).rgb;
}

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let dividerHalf = max(0.001, cu.dividerWidth * 0.5);
  if (abs(uv.x - 0.5) < dividerHalf) {
    return vec4<f32>(0.96, 0.78, 0.22, 1.0);
  }

  if (uv.x < 0.5) {
    return vec4<f32>(sampleSourceFitted(uv), 1.0);
  }

  let rightUV = vec2<f32>((uv.x - 0.5) * 2.0, uv.y);
  return vec4<f32>(compositeAt(rightUV), 1.0);
}
`;

