import { DECAY_GLSL } from '../../shaders/decayLiterals';
import { DARK_RGB_MAX, type LayerSpec } from '../layerSpecs';
import type { CoincidenceDecayOptions } from './wgsl';

export type { CoincidenceDecayOptions } from './wgsl';

/**
 * GLSL ES 3.00 template library — the WebGL diagnostic backend's half of the
 * node-kind templates. A node kind is supported on WebGL exactly when it has an
 * emitter here; `capabilities.ts` turns that into a compile-time answer.
 */

const layerList = (count: number) => Array.from({ length: count }, (_, i) => i);

/**
 * GLSL twin of `WGSL_MOTION_HELPERS` — same maths, same names, so the two
 * backends stay comparable by eye when a motion preset diverges.
 */
export const GLSL_MOTION_HELPERS = `
vec3 motionDirectionRgb(vec2 flow, float magnitude, float gain) {
  float hue = fract(atan(flow.y, flow.x) / 6.2831853 + 1.0);
  vec3 k = vec3(0.0, 8.0, 4.0) + hue * 12.0;
  vec3 wedge = clamp(abs(mod(k, 6.0) - 3.0) - 1.0, vec3(0.0), vec3(1.0));
  vec3 rgb = 0.5 - 0.45 + 0.45 * wedge;
  return rgb * clamp(magnitude * gain, 0.0, 1.0);
}

float motionDecayScale(float magnitude, float bias, bool enabled) {
  return enabled ? max(1.0 - bias * magnitude, 0.0) : 1.0;
}
`;

/** `cropColor` — every layer's CROP ramp behind one `int layer` switch. */
export function emitCropColorGlsl(specs: readonly LayerSpec[]): string {
  const bodies = specs.map((spec, index) => {
    const last = index === specs.length - 1;
    const localName = (i: number) => spec.crop[i]?.glslName ?? spec.crop[i]?.name ?? 'dark';
    const decls = spec.crop
      .map((band, i) => `  vec4 ${localName(i)} = vec4(${band.rgb}, nonAlpha);`)
      .join('\n');
    const hard = spec.crop
      .map((band, i) => {
        const upper = spec.cropUpper === null
          ? ''
          : ` && bandLum < ${i === 0 ? spec.cropUpper : spec.crop[i - 1].lower}`;
        return `    if (bandLum >= ${band.lower}${upper}) return ${localName(i)};`;
      })
      .join('\n');
    const soft = spec.crop
      .map((band, i) => {
        const next = i + 1 < spec.crop.length ? localName(i + 1) : 'dark';
        const edge = spec.cropUpper === null
          ? band.lower
          : spec.crop[i - 1]?.lower ?? band.lower;
        if (i === 0 && spec.cropUpper !== null) {
          return `  if (bandLum >= ${band.lower} - tw) return mix(mix(${next}, ${localName(i)}, softThreshold(bandLum, ${band.lower}, tw)), dark, softThreshold(bandLum, ${spec.cropUpper}, tw));`;
        }
        return `  if (bandLum >= ${band.lower} - tw) return mix(${next}, ${localName(i)}, softThreshold(bandLum, ${edge}, tw));`;
      })
      .join('\n');

    const body = [
      decls,
      '  vec4 dark = vec4(0.0, 0.0, 0.0, darkAlpha);',
      '  if (soft < 0.5) {',
      hard,
      '    return dark;',
      '  }',
      soft,
      '  return dark;',
    ].join('\n');

    // The final layer is the fall-through case, so it needs no guard.
    return last
      ? body
      : `  if (layer == ${spec.index}) {\n${body.replace(/^/gm, '  ')}\n  }`;
  });

  return `vec4 cropColor(int layer, float bandLum, float soft, float nonAlpha, float darkAlpha) {
  float tw = 2.2;
${bodies.join('\n')}
}`;
}

/** `fixedLayerColor` — every layer's CR0P-fixed ramp behind one `int layer` switch. */
export function emitFixedLayerColorGlsl(specs: readonly LayerSpec[]): string {
  const bodies = specs.map((spec, index) => {
    const last = index === specs.length - 1;
    const arms = spec.fixed.map((band) => {
      if (band.highlight) {
        return [
          `  if (rgb > ${band.lower}) {`,
          `    float g = clamp((grey + (rgb - ${band.lower})) / 255.0, 0.0, 1.0);`,
          '    return vec4(g, g, g, 1.0);',
          '  }',
        ].join('\n');
      }
      const cond = band.upper === null
        ? `rgb > ${band.lower}`
        : `rgb > ${band.lower} && rgb <= ${band.upper}`;
      return `  if (${cond}) return vec4(${band.rgba});`;
    });
    arms.push(`  if (rgb <= ${DARK_RGB_MAX}) return vec4(gDark, gDark, gDark, 1.0);`);
    arms.push('  return vec4(0.0);');
    const body = arms.join('\n');
    return last
      ? body
      : `  if (layer == ${spec.index}) {\n${body.replace(/^/gm, '  ')}\n  }`;
  });

  return `vec4 fixedLayerColor(int layer, float lum) {
  float diff = (u_avgLuminance / 255.0) * 32.0;
  float lightDark = 128.0 + abs(u_avgLuminance - 128.0) / 2.0;
  float rgb = lum + lightDark / 2.0;
  float grey = u_avgLuminance;
  float gDark = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
${bodies.join('\n')}
}`;
}

/** Chromashift gradient mode colour selection (shared by layer + debug shaders). */
export function emitGradientBranchGlsl(specs: readonly LayerSpec[]): string {
  const blocks = specs.map((spec, index) => {
    const last = index === specs.length - 1;
    const head = index === 0
      ? `    if (u_layerIndex == ${spec.index}) {`
      : last
        ? '    } else {'
        : `    } else if (u_layerIndex == ${spec.index}) {`;
    const arms = spec.gradient
      .map((band, i) => {
        const cond = band.bounded
          ? `lum > ${band.lo} && lum <= ${band.hi}`
          : `lum > ${band.lo}`;
        const args = `lum, ${band.lo}, ${band.hi}, ${band.hueLo}, ${band.hueHi}, ${band.sat}, ${band.lumLo}, ${band.lumHi}`;
        const keyword = i === 0 ? 'if' : 'else if';
        return `      ${keyword} (${cond}) result = vec4(bandGradient(${args}), 1.0);`;
      })
      .join('\n');
    return `${head}\n${arms}`;
  });
  return `\n${blocks.join('\n')}\n    }\n`;
}

/**
 * `nonAlpha` selector for CROP NUNIF2. Layers whose alpha already matches the
 * fall-through value are folded into it, so the common "layer 0 differs, the
 * rest share" case stays a two-arm ternary.
 */
export function emitNunifAlphaGlsl(specs: readonly LayerSpec[]): string {
  const tail = specs[specs.length - 1].nunif2Alpha;
  const head = specs
    .slice(0, -1)
    .filter((spec) => spec.nunif2Alpha !== tail)
    .map((spec) => `isNunif2 && u_layerIndex == ${spec.index} ? ${spec.nunif2Alpha} : `)
    .join('');
  return `${head}isNunif2 ? ${tail} : 1.0`;
}

/** `coincidence` + `decay` → the WebGL persistence pass. */
export function emitCoincidenceDecayGlsl(
  layerCount: number,
  options: CoincidenceDecayOptions = {},
): string {
  const motion = options.motion === true;
  const layers = layerList(layerCount);
  const uniforms = layers.map((i) => `uniform sampler2D u_layer${i};`).join('\n');
  const samples = layers.map((i) => `  vec4 c${i} = texture(u_layer${i}, v_uv);`).join('\n');
  const count = layers.map((i) => `step(0.01, c${i}.a)`).join(' + ');
  const weighted = layers.map((i) => `c${i}.rgb * step(0.01, c${i}.a)`).join(' + ');
  const fullOverlap = (layerCount - 1).toFixed(1);

  // Mirrors the WGSL variant field for field: same binding shape, same modes,
  // same decay bias, so a preset looks the same on the diagnostic backend.
  const motionUniforms = motion
    ? '\nuniform sampler2D u_motion;\nuniform int u_motionMode;'
      + '\nuniform float u_motionGain;\nuniform float u_motionDecayBias;\n'
      + GLSL_MOTION_HELPERS
    : '';
  const motionSample = motion
    ? '  vec4 motionSample = texture(u_motion, v_uv);\n'
      + '  float motion = clamp(motionSample.r, 0.0, 1.0);\n'
    : '';
  // The parenthesised form is emitted only for the motion variant: without it
  // the non-motion token stream stays byte-identical to the golden source.
  const decayMod = motion
    ? `(hadOverlap ? ${DECAY_GLSL.overlapDecayExponent} : ${DECAY_GLSL.idleDecayExponent})`
      + ' * motionDecayScale(motion, u_motionDecayBias, u_motionMode != 0)'
    : `hadOverlap ? ${DECAY_GLSL.overlapDecayExponent} : ${DECAY_GLSL.idleDecayExponent}`;
  const motionTerm = motion
    ? [
        '',
        '  // Temporal term — see the WGSL emitter for the mode semantics.',
        '  if (u_motionMode == 2 && motion <= 0.0) {',
        '    outColor = decayed;',
        '    return;',
        '  }',
        '  if (u_motionMode == 3) {',
        '    stamped = motionDirectionRgb(motionSample.gb, motion, u_motionGain);',
        '  } else if (u_motionMode != 0) {',
        '    stamped = min(stamped * (1.0 + u_motionGain * motion), vec3(1.0));',
        '  }',
      ].join('\n')
    : '';

  return `#version 300 es
precision highp float;

${uniforms}
uniform sampler2D u_previous;
uniform float u_decay;
uniform float u_stampBoost;
uniform int u_tracerMode;
uniform int u_peakMode;
${motionUniforms}
in vec2 v_uv;
out vec4 outColor;

void main() {
${samples}
  vec4 prev = texture(u_previous, v_uv);
${motionSample}  // count is an exact sum of step() results (each 0.0 or 1.0), so the integer
  // comparisons below need no epsilon.
  float count = ${count};
  bool hadOverlap = count > 1.0;
  // Decay modifier: decay faster when actively overlapping, slower otherwise —
  // mirrors the WGSL persistence pass and effectiveDecay() in math/decay.ts.
  float decayMod = ${decayMod};
  float effectiveDecay = pow(u_decay, decayMod);
  // Peak mode discards the decayed history so only fresh collision stamps show,
  // mirroring the WebGPU persistence pass (peakMode -> decayed = 0).
  vec4 decayed = u_peakMode == 1 ? vec4(0.0) : prev * effectiveDecay;
  if (!hadOverlap) {
    outColor = decayed;
    return;
  }
  vec3 combined = (${weighted}) / count;
  float lum = dot(combined, vec3(0.2126, 0.7152, 0.0722));
  vec3 stamped = u_tracerMode == 1 ? vec3(min(lum * u_stampBoost, 1.0)) : min(combined * u_stampBoost, vec3(1.0));
${motionTerm}
  vec4 fresh = vec4(stamped, count > ${fullOverlap} ? 1.0 : 0.72);
  outColor = max(decayed, fresh);
}
`;
}

/** `blend` → the WebGL compositor pass. */
export function emitCompositorGlsl(layerCount: number): string {
  const layers = layerList(layerCount);
  const samplers = layers.map((i) => `uniform sampler2D u_layer${i};`).join('\n');
  const opacities = layers.map((i) => `uniform float u_layerOpacity${i};`).join('\n');
  const collisionParams = layers.map((i) => `vec4 c${i}`).join(', ');
  const collisionCount = layers.map((i) => `step(0.01, c${i}.a)`).join(' + ');
  const collisionArgs = layers.map((i) => `c${i}`).join(', ');
  const scaled = (uv: string) => layers
    .map((i) => `  vec4 c${i} = scaleAlpha(texture(u_layer${i}, ${uv}), u_layerOpacity${i});`)
    .join('\n');
  const live = layers
    .slice(1)
    .reduce((acc, i) => `blendOver(${acc}, c${i}, u_layerBlendMode)`, 'c0');
  // Layer-isolation main-view modes start at 3 and run one per layer.
  const isolationArms = layers
    .map((i) => `  if (u_mainViewMode == ${3 + i}) {\n    outColor = vec4(texture(u_layer${i}, v_uv).rgb, 1.0);\n    return;\n  }`)
    .join('\n');
  const heatmapMode = 3 + layerCount;
  const fullOverlap = (layerCount - 0.5).toFixed(1);

  return `#version 300 es
precision highp float;

${samplers}
uniform sampler2D u_tracerBelow;
uniform sampler2D u_tracerAbove;
${opacities}
uniform float u_tracerBelowOpacity;
uniform float u_tracerAboveOpacity;
uniform int u_layerBlendMode;
uniform int u_tracerBlendMode;
uniform int u_outputMode;
uniform int u_mainViewMode;
uniform int u_diagnosticsMode;
uniform float u_diagnosticsOpacity;
uniform int u_viewportQuarterZoom;
uniform int u_viewportHalfOverlay;
uniform float u_halfOverlayAlpha;

in vec2 v_uv;
out vec4 outColor;

vec4 scaleAlpha(vec4 c, float opacity) {
  return vec4(c.rgb, c.a * opacity);
}

vec2 viewportSampleUV(vec2 uv) {
  if (u_viewportQuarterZoom == 0) {
    return uv;
  }
  return vec2(uv.x * 0.5, uv.y * 0.5 + 0.5);
}

vec3 blendRgb(vec3 d, vec3 s, int mode) {
  if (mode == 1) return min(d + s, vec3(1.0));
  if (mode == 2) return max(d - s, vec3(0.0));
  if (mode == 3) return d * s;
  if (mode == 4) return 1.0 - (1.0 - d) * (1.0 - s);
  if (mode == 5) return max(d, s);
  if (mode == 6) return min(d, s);
  if (mode == 10) return abs(d - s);
  if (mode == 11) return d + s - 2.0 * d * s;
  return s;
}

vec4 blendOver(vec4 dst, vec4 src, int mode) {
  if (src.a <= 0.0) return dst;
  if (dst.a <= 0.0) return src;
  vec3 blended = blendRgb(dst.rgb, src.rgb, mode);
  float outA = src.a + dst.a * (1.0 - src.a);
  vec3 rgb = (
    src.rgb * src.a * (1.0 - dst.a) +
    dst.rgb * dst.a * (1.0 - src.a) +
    blended * src.a * dst.a
  ) / max(outA, 0.0001);
  return vec4(clamp(rgb, 0.0, 1.0), outA);
}

vec4 collisionColor(${collisionParams}) {
  float count = ${collisionCount};
  if (count < 1.5) return vec4(0.0);
  return count > ${fullOverlap} ? vec4(1.0, 0.85, 0.1, 1.0) : vec4(0.2, 0.8, 1.0, 0.8);
}

vec4 compositeProcessed(vec2 sampleUV) {
${scaled('sampleUV')}
  vec4 below = scaleAlpha(texture(u_tracerBelow, sampleUV), u_tracerBelowOpacity);
  vec4 above = scaleAlpha(texture(u_tracerAbove, sampleUV), u_tracerAboveOpacity);
  vec4 live = ${live};
  vec4 tracer = blendOver(below, above, u_tracerBlendMode);
  vec4 finalColor = u_outputMode == 2 ? tracer : u_outputMode == 1 ? blendOver(tracer, live, u_layerBlendMode) : blendOver(live, tracer, u_tracerBlendMode);
  if (u_diagnosticsMode == 1) {
    finalColor = blendOver(finalColor, scaleAlpha(collisionColor(${collisionArgs}), u_diagnosticsOpacity), 4);
  }
  return vec4(finalColor.rgb, 1.0);
}

void main() {
  if (u_mainViewMode == 1) {
    vec4 below = scaleAlpha(texture(u_tracerBelow, v_uv), u_tracerBelowOpacity);
    vec4 above = scaleAlpha(texture(u_tracerAbove, v_uv), u_tracerAboveOpacity);
    outColor = vec4(blendOver(below, above, u_tracerBlendMode).rgb, 1.0);
    return;
  }
${isolationArms}
  if (u_mainViewMode == ${heatmapMode} || u_mainViewMode == 11) {
${scaled('v_uv')}
    outColor = vec4(collisionColor(${collisionArgs}).rgb, 1.0);
    return;
  }

  if (u_viewportHalfOverlay == 1) {
    if (v_uv.y > 0.5) {
      outColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    vec2 topUV = vec2(v_uv.x, v_uv.y);
    vec2 bottomUV = vec2(v_uv.x, v_uv.y + 0.5);
    vec4 topCol = compositeProcessed(topUV);
    vec4 bottomCol = compositeProcessed(bottomUV);
    float alpha = clamp(u_halfOverlayAlpha, 0.0, 1.0);
    outColor = vec4(mix(topCol.rgb, bottomCol.rgb, alpha), 1.0);
    return;
  }

  outColor = compositeProcessed(viewportSampleUV(v_uv));
}
`;
}

/** Shared GLSL band-colour helpers: HSL maths plus every layer's crop and fixed ramp. */
export function emitBandColorHelpersGlsl(specs: readonly LayerSpec[]): string {
  return `
vec3 hsl2rgb(float h, float s, float l) {
  vec3 k = vec3(0.0, 8.0, 4.0) + h * 12.0;
  vec3 rgb = clamp(abs(mod(k, 6.0) - 3.0) - 1.0, 0.0, 1.0);
  float a = s * min(l, 1.0 - l);
  return l - a + a * rgb;
}

vec3 bandGradient(float value, float low, float high, float hueLow, float hueHigh, float sat, float lumLow, float lumHigh) {
  float t = clamp((value - low) / max(0.0001, high - low), 0.0, 1.0);
  return hsl2rgb(mix(hueLow, hueHigh, t) / 360.0, sat, mix(lumLow, lumHigh, t));
}

float softThreshold(float v, float edge, float width) {
  return smoothstep(edge - width, edge + width, v);
}

${emitCropColorGlsl(specs)}

${emitFixedLayerColorGlsl(specs)}
`;
}

/** `band-layer` node → GLSL fragment shader (`u_layerIndex` selects the ramp). */
export function emitBandLayerGlsl(specs: readonly LayerSpec[]): string {
  return `#version 300 es
precision highp float;

uniform sampler2D u_source;
uniform int u_layerIndex;
uniform float u_avgLuminance;
uniform float u_layerOpacity;
uniform float u_colorMode;
uniform float u_sobelEnabled;
uniform float u_softCropEnabled;
uniform sampler2D u_profileLut;
uniform float u_profileMode;
uniform float u_profileLightDark;

in vec2 v_uv;
in vec2 v_baseUv;
out vec4 outColor;

float luminanceAt(vec2 uv) {
  vec3 c = texture(u_source, uv).rgb;
  return dot(c, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
}

float boostedLuminance(vec2 uv, float baseLum) {
  if (u_sobelEnabled < 0.5) return baseLum;
  vec2 texel = 1.0 / vec2(textureSize(u_source, 0));
  float tl = luminanceAt(uv + texel * vec2(-1.0, -1.0));
  float tc = luminanceAt(uv + texel * vec2(0.0, -1.0));
  float tr = luminanceAt(uv + texel * vec2(1.0, -1.0));
  float ml = luminanceAt(uv + texel * vec2(-1.0, 0.0));
  float mr = luminanceAt(uv + texel * vec2(1.0, 0.0));
  float bl = luminanceAt(uv + texel * vec2(-1.0, 1.0));
  float bc = luminanceAt(uv + texel * vec2(0.0, 1.0));
  float br = luminanceAt(uv + texel * vec2(1.0, 1.0));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  return clamp(baseLum + 16.0 * length(vec2(gx, gy)), 0.0, 255.0);
}

${emitBandColorHelpersGlsl(specs)}

/**
 * Named colour profile lookup (docs/COLOR_PROFILES.md) — column = preprocessed
 * luminance bucket, row = layer index. ceil() matches the CPU band rule
 * (value > min && value <= max) exactly for integer band bounds.
 */
vec4 profileColor(float lum) {
  float lift = u_profileLightDark > 0.5
    ? (128.0 + abs(u_avgLuminance - 128.0) * 0.5) * 0.5
    : 0.0;
  float value = clamp(lum + lift, 0.0, 255.0);
  int col = int(clamp(ceil(value), 0.0, 255.0));
  return texelFetch(u_profileLut, ivec2(col, u_layerIndex), 0);
}

void main() {
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  vec4 sampleColor = texture(u_source, v_uv);
  float rawLum = dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
  float lum = boostedLuminance(v_uv, rawLum);

  if (u_profileMode > 0.5) {
    vec4 profile = profileColor(lum);
    outColor = vec4(profile.rgb, profile.a * u_layerOpacity);
    return;
  }

  vec4 result = vec4(0.0);
  if (u_colorMode == 1.0) {
${emitGradientBranchGlsl(specs)}
  } else if (u_colorMode >= 1.5) {
    float adjusted = lum + (128.0 + abs(u_avgLuminance - 128.0) * 0.5) * 0.5;
    bool isNunif2 = u_colorMode > 2.5;
    float bandLum = isNunif2 ? adjusted : lum;
    float nonAlpha = ${emitNunifAlphaGlsl(specs)};
    float darkAlpha = isNunif2 ? 0.1 : 0.0;
    result = cropColor(u_layerIndex, bandLum, u_softCropEnabled, nonAlpha, darkAlpha);
  } else {
    result = fixedLayerColor(u_layerIndex, lum);
  }

  outColor = vec4(result.rgb, result.a * u_layerOpacity);
}
`;
}

/** `lut` → a standalone colour-profile lookup pass. */
export function emitLutGlsl(rows: number): string {
  return `#version 300 es
precision highp float;

uniform sampler2D u_source;
uniform sampler2D u_lut;
uniform float u_row;
uniform float u_lightDark;
uniform float u_avgLuminance;
uniform float u_mixAmount;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec4 src = texture(u_source, v_uv);
  float lum = dot(src.rgb, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
  float lift = u_lightDark > 0.5
    ? (128.0 + abs(u_avgLuminance - 128.0) * 0.5) * 0.5
    : 0.0;
  int col = int(clamp(ceil(clamp(lum + lift, 0.0, 255.0)), 0.0, 255.0));
  int row = int(clamp(u_row, 0.0, ${(rows - 1).toFixed(1)}));
  vec4 graded = texelFetch(u_lut, ivec2(col, row), 0);
  outColor = mix(src, graded, clamp(u_mixAmount, 0.0, 1.0));
}
`;
}
