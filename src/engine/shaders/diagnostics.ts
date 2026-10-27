import { WGSL_BLEND_HELPERS, WGSL_OUTPUT_ENCODE } from './common';
import {
  defineUniformLayout,
  emitUniformStructWgsl,
  type UniformFieldSpec,
  type UniformLayout,
} from '../graph/templates/uniformLayout';

/**
 * Uniform layouts of the inspection passes below. The tracer view and the
 * compare split read every band layer, so their blocks carry one opacity per
 * layer; each is memoised per count.
 */
const tracerViewLayouts = new Map<number, UniformLayout<TracerViewUniformName>>();
const compareLayouts = new Map<number, UniformLayout<CompareUniformName>>();

export type TracerViewUniformName =
  | 'canvasAspect' | 'texAspect' | 'tracerAboveOpacity' | 'tracerBelowOpacity'
  | 'tracerBlendMode' | 'showHeatmap' | 'zoom' | 'panX' | 'panY' | 'heatmapOpacity'
  | 'exposure' | 'applyTonemap' | 'showLayers' | 'layerBlendMode' | `layerOpacity${number}`;

export type CompareUniformName =
  | 'sourceAspect' | 'tracerAboveOpacity' | 'tracerBelowOpacity' | 'layerBlendMode'
  | 'tracerBlendMode' | `layerOpacity${number}` | 'stampBoost' | 'dividerWidth'
  | 'outputMode' | 'tracerMode';

const layerOpacityFields = (layerCount: number) =>
  Array.from({ length: layerCount }, (_, i) => ({ name: `layerOpacity${i}` as const, kind: 'f32' as const }));

export function tracerViewUniformLayout(layerCount: number): UniformLayout<TracerViewUniformName> {
  let layout = tracerViewLayouts.get(layerCount);
  if (!layout) {
    const fields: UniformFieldSpec<TracerViewUniformName>[] = [
      { name: 'canvasAspect', kind: 'f32' },
      { name: 'texAspect', kind: 'f32' },
      { name: 'tracerAboveOpacity', kind: 'f32' },
      { name: 'tracerBelowOpacity', kind: 'f32' },
      { name: 'tracerBlendMode', kind: 'u32' },
      { name: 'showHeatmap', kind: 'u32' },
      { name: 'zoom', kind: 'f32' },
      { name: 'panX', kind: 'f32' },
      { name: 'panY', kind: 'f32' },
      { name: 'heatmapOpacity', kind: 'f32' },
      { name: 'exposure', kind: 'f32' },
      { name: 'applyTonemap', kind: 'u32' },
      { name: 'showLayers', kind: 'u32' },
      { name: 'layerBlendMode', kind: 'u32' },
      ...layerOpacityFields(layerCount),
    ];
    layout = defineUniformLayout('TracerViewUniforms', fields, { column: 19 });
    tracerViewLayouts.set(layerCount, layout);
  }
  return layout;
}

export function compareUniformLayout(layerCount: number): UniformLayout<CompareUniformName> {
  let layout = compareLayouts.get(layerCount);
  if (!layout) {
    const fields: UniformFieldSpec<CompareUniformName>[] = [
      { name: 'sourceAspect', kind: 'f32' },
      { name: 'tracerAboveOpacity', kind: 'f32' },
      { name: 'tracerBelowOpacity', kind: 'f32' },
      { name: 'layerBlendMode', kind: 'u32' },
      { name: 'tracerBlendMode', kind: 'u32' },
      ...layerOpacityFields(layerCount),
      { name: 'stampBoost', kind: 'f32' },
      { name: 'dividerWidth', kind: 'f32' },
      { name: 'outputMode', kind: 'u32' },
      { name: 'tracerMode', kind: 'u32' },
    ];
    layout = defineUniformLayout('CompareUniforms', fields, { column: 19 });
    compareLayouts.set(layerCount, layout);
  }
  return layout;
}

export const DISPLAY_UNIFORMS = defineUniformLayout('DisplayUniforms', [
  { name: 'canvasAspect', kind: 'f32' },
  { name: 'texAspect', kind: 'f32' },
  // Was a "tonemap on/off" flag back when this pass carried its own Reinhard
  // curve. Output is now just the sRGB OETF, which every source this pass
  // shows needs unconditionally, so the slots are padding.
  { name: '_pad0', kind: 'u32' },
  { name: '_pad1', kind: 'u32' },
], { column: 13 });

export const HEATMAP_UNIFORMS = defineUniformLayout('HeatmapUniforms', [
  { name: 'threshold', kind: 'f32' },
  { name: '_pad0', kind: 'f32' },
  { name: '_pad1', kind: 'u32' },
  { name: '_pad2', kind: 'u32' },
], { column: 10 });

// ─── Tracer View (centered aspect-fit blit, issues #58/#59/#61) ──────────────
// "Show Full Tracer" inspection path. Previously bypassed the compositor
// entirely, causing mismatched hue/brightness and ignoring user controls.
// Now uses the same blend helpers and Reinhard tonemap, respects
// tracerAboveOpacity/tracerBelowOpacity/tracerBlendMode, and still preserves
// the aspect-fit letterboxing for non-1.0 tracerScale values.
/** The full-res tracer view for `layerCount` band layers (the layers only show as an overlay). */
export function emitTracerViewWgsl(layerCount: number): string {
  const layers = Array.from({ length: layerCount }, (_, i) => i);
  const bindings = layers
    .map((i) => `@group(0) @binding(${i + 3}) var layer${i}      : texture_2d<f32>;`)
    .join('\n');
  const sampled = (pad: string) => layers
    .map((i) => `${pad}let c${i} = textureSampleLevel(layer${i}, texSampler, sampleUV, 0.0);`)
    .join('\n');
  const scaled = layers
    .map((i) => `    let c${i}s = scale_premultiplied(c${i}, tvu.layerOpacity${i});`)
    .join('\n');
  // Painter's order, as in the compositor: the last layer goes down first.
  const stacked = [...layers].reverse()
    .map((i) => `    col = blend(col, c${i}s, tvu.layerBlendMode);`)
    .join('\n');
  const counted = layers
    .map((i) => `    if (c${i}.a > 0.05) { count = count + 1u; }`)
    .join('\n');
  return /* wgsl */ `
${WGSL_BLEND_HELPERS}
${WGSL_OUTPUT_ENCODE}

@group(0) @binding(0) var texSampler  : sampler;
@group(0) @binding(1) var persistAbove: texture_2d<f32>;
@group(0) @binding(2) var persistBelow: texture_2d<f32>;
${bindings}

${emitUniformStructWgsl(tracerViewUniformLayout(layerCount))}
@group(0) @binding(${layerCount + 3}) var<uniform> tvu : TracerViewUniforms;

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
${sampled('    ')}
${scaled}
${stacked}
  }

  if (tvu.showHeatmap == 1u) {
${sampled('    ')}
    var count = 0u;
${counted}
    var overlay = vec3<f32>(0.0);
    if (count == 2u) {
      overlay = vec3<f32>(1.0, 0.92, 0.18);
    } else if (count >= 3u) {
      overlay = vec3<f32>(1.0, 1.0, 1.0);
    }
    col = vec4<f32>(max(col.rgb, mix(col.rgb, overlay, tvu.heatmapOpacity)), col.a);
  }

  // Same output transfer function as the compositor, so the inspector and the
  // main view agree pixel for pixel. Exposure is a linear-light gain applied
  // before the encode; it defaults to 1.04 in the inspector controls.
  if (tvu.applyTonemap == 1u) {
    return vec4<f32>(encode_display(col.rgb * tvu.exposure), 1.0);
  }
  return vec4<f32>(encode_display(col.rgb), 1.0);
}
`;
}

export const displayTextureFragmentSource = /* wgsl */ `
${WGSL_OUTPUT_ENCODE}

@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var tex        : texture_2d<f32>;

${emitUniformStructWgsl(DISPLAY_UNIFORMS)}
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

  // The sampled texture is linear light (source images are uploaded as
  // rgba8unorm-srgb and the internal targets store linear), so it needs the
  // OETF on the way out to the non-sRGB canvas format.
  let sampleColor = textureSampleLevel(tex, texSampler, sampleUV, 0.0);
  return vec4<f32>(encode_display(sampleColor.rgb), 1.0);
}
`;

/** The coincidence heatmap over `layerCount` band layers: dim where under two overlap, warm at two, hot at three or more. */
export function emitCoincidenceHeatmapWgsl(layerCount: number): string {
  const layers = Array.from({ length: layerCount }, (_, i) => i);
  const bindings = layers
    .map((i) => `@group(0) @binding(${i + 1}) var layer${i}     : texture_2d<f32>;`)
    .join('\n');
  const sampled = layers.map((i) => `  let c${i} = textureSample(layer${i}, texSampler, uv);`).join('\n');
  const counted = layers.map((i) => `  if (c${i}.a > hu.threshold) { count = count + 1u; }`).join('\n');
  const maxBand = layers.slice(1).reduce((acc, i) => `max(${acc}, c${i}.rgb)`, 'c0.rgb');
  const combined = layers.map((i) => `c${i}.rgb`).join(' + ');
  return /* wgsl */ `
${WGSL_OUTPUT_ENCODE}

@group(0) @binding(0) var texSampler : sampler;
${bindings}

${emitUniformStructWgsl(HEATMAP_UNIFORMS)}
@group(0) @binding(${layerCount + 1}) var<uniform> hu : HeatmapUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
${sampled}

  var count = 0u;
${counted}

  if (count < 2u) {
    let maxBand = ${maxBand} * 0.22;
    return vec4<f32>(encode_display(maxBand), 1.0);
  }

  let combined = ${combined};
  if (count == 2u) {
    let warm = normalize(max(combined, vec3<f32>(0.0001))) * vec3<f32>(1.0, 0.9, 0.25);
    return vec4<f32>(encode_display(warm), 1.0);
  }

  let hot = vec3<f32>(1.0, 0.98, 0.98) + combined * 0.15;
  return vec4<f32>(encode_display(min(hot, vec3<f32>(1.0))), 1.0);
}
`;
}

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

/** The source | composite split for `layerCount` band layers. */
export function emitCompareWgsl(layerCount: number): string {
  const layers = Array.from({ length: layerCount }, (_, i) => i);
  const bindings = layers
    .map((i) => `@group(0) @binding(${i + 2}) var layer${i}         : texture_2d<f32>;`)
    .join('\n');
  const sampled = layers
    .map((i) => `  let c${i} = scale_premultiplied(textureSampleLevel(layer${i}, cSampler, uv, 0.0), cu.layerOpacity${i});`)
    .join('\n');
  const stacked = [...layers].reverse()
    .map((i) => `  layerCol = blend(layerCol, c${i}, cu.layerBlendMode);`)
    .join('\n');
  const counted = layers.map((i) => `    if (c${i}.a > thresh) { layerCount = layerCount + 1u; }`).join('\n');
  const summed = layers.map((i) => `      if (c${i}.a > thresh) { sum = sum + c${i}.rgb; }`).join('\n');
  return /* wgsl */ `
${WGSL_BLEND_HELPERS}
${WGSL_OUTPUT_ENCODE}

@group(0) @binding(0) var cSampler       : sampler;
@group(0) @binding(1) var sourceTex      : texture_2d<f32>;
${bindings}
@group(0) @binding(${layerCount + 2}) var persistBelow   : texture_2d<f32>;
@group(0) @binding(${layerCount + 3}) var persistAbove   : texture_2d<f32>;

${emitUniformStructWgsl(compareUniformLayout(layerCount))}
@group(0) @binding(${layerCount + 4}) var<uniform> cu : CompareUniforms;

fn compositeAt(uv : vec2<f32>) -> vec3<f32> {
${sampled}
  let pBelow = scale_premultiplied(textureSampleLevel(persistBelow, cSampler, uv, 0.0), cu.tracerBelowOpacity);
  let pAbove = scale_premultiplied(textureSampleLevel(persistAbove, cSampler, uv, 0.0), cu.tracerAboveOpacity);

  var layerCol = vec4<f32>(0.0);
${stacked}

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
${counted}
    if (layerCount >= 2u) {
      var sum = vec3<f32>(0.0);
${summed}
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

  return finalCol.rgb;
}

fn sampleSourceFitted(uv : vec2<f32>) -> vec3<f32> {
  let halfAspect = 0.5 * cu.sourceAspect;
  var sampleUV = vec2<f32>(uv.x * 2.0, uv.y);

  if (halfAspect > 1.0 + 0.0001) {
    let visH = 1.0 / halfAspect;
    let y0 = (1.0 - visH) * 0.5;
    if (uv.y < y0 || uv.y > y0 + visH) {
      return vec3<f32>(0.00155, 0.00155, 0.00235);
    }
    sampleUV.y = (uv.y - y0) / visH;
  } else if (1.0 > halfAspect + 0.0001) {
    let visW = halfAspect;
    let x0 = (1.0 - visW) * 0.5;
    let localX = uv.x * 2.0;
    if (localX < x0 || localX > x0 + visW) {
      return vec3<f32>(0.00155, 0.00155, 0.00235);
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
    return vec4<f32>(encode_display(sampleSourceFitted(uv)), 1.0);
  }

  let rightUV = vec2<f32>((uv.x - 0.5) * 2.0, uv.y);
  return vec4<f32>(encode_display(compositeAt(rightUV)), 1.0);
}
`;
}

/** The canonical three-layer inspection sources. */
export const tracerViewFragmentSource = emitTracerViewWgsl(3);
export const coincidenceHeatmapFragmentSource = emitCoincidenceHeatmapWgsl(3);
export const compareFragmentSource = emitCompareWgsl(3);
