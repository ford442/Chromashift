import { DECAY_WGSL } from '../../shaders/decayLiterals';
import { DARK_RGB_MAX, type LayerSpec } from '../layerSpecs';

/**
 * WGSL template library — one emitter per node kind.
 *
 * These are the bodies the old hand-written shader modules used to hold; the
 * modules now call into here, so `src/engine/shaders/*.ts` stays the assembly
 * point and this file owns the per-node code. Every emitter is a pure function
 * of a spec, which is what makes an arbitrary layer count possible.
 */

const indent = (depth: number) => '  '.repeat(depth);

/** `cropLayer<N>Color` — the CROP / CROP-NUNIF2 colour ramp for one layer. */
export function emitCropHelperWgsl(spec: LayerSpec): string {
  const { crop, cropUpper } = spec;
  const decls = crop
    .map((band) => `  let ${band.name} = vec4<f32>(${band.rgb}, nonAlpha);`)
    .join('\n');

  const hardArms = crop
    .map((band, i) => {
      const upper = cropUpper === null
        ? ''
        : ` && bandLum < ${i === 0 ? cropUpper : crop[i - 1].lower}`;
      return `    if (bandLum >= ${band.lower}${upper}) { return ${band.name}; }`;
    })
    .join('\n');

  const softArms = crop
    .map((band, i) => {
      const next = crop[i + 1]?.name ?? 'dark';
      // The soft edge is anchored at this band's own threshold for an
      // open-topped layer, and at the band above it otherwise — that is what
      // keeps a bounded layer's top edge fading out rather than in.
      const edge = cropUpper === null ? band.lower : crop[i - 1]?.lower ?? band.lower;
      if (i === 0 && cropUpper !== null) {
        return [
          `  if (bandLum >= ${band.lower} - tw) {`,
          `    let inner = mix(${next}, ${band.name}, softThreshold(bandLum, ${band.lower}, tw));`,
          `    return mix(inner, dark, softThreshold(bandLum, ${cropUpper}, tw));`,
          '  }',
        ].join('\n');
      }
      return [
        `  if (bandLum >= ${band.lower} - tw) {`,
        `    return mix(${next}, ${band.name}, softThreshold(bandLum, ${edge}, tw));`,
        '  }',
      ].join('\n');
    })
    .join('\n');

  return `
fn ${cropFnName(spec)}(bandLum: f32, soft: f32, nonAlpha: f32, darkAlpha: f32) -> vec4<f32> {
${decls}
  let dark = vec4<f32>(0.0, 0.0, 0.0, darkAlpha);
  if (soft < 0.5) {
${hardArms}
    return dark;
  }
  let tw = SOFT_CROP_TW;
${softArms}
  return dark;
}
`;
}

export function cropFnName(spec: LayerSpec): string {
  return `cropLayer${spec.index}Color`;
}

/** Every layer's crop helper, concatenated in layer order. */
export function emitCropHelpersWgsl(specs: readonly LayerSpec[]): string {
  return specs.map(emitCropHelperWgsl).join('');
}

/** Backend-agnostic colour maths every `band-layer` shader links against. */
export const WGSL_COLOR_HELPER_PRELUDE = /* wgsl */ `
fn hsl2rgb(h: f32, s: f32, l: f32) -> vec3<f32> {
  let a = s * min(l, 1.0 - l);
  let k = vec3<f32>(0.0, 8.0, 4.0) + h * 12.0;
  let rgb = clamp(abs((k % 6.0) - 3.0) - 1.0, vec3<f32>(0.0), vec3<f32>(1.0));
  return l - a + a * rgb;
}

fn band_gradient(
  val       : f32,
  low       : f32,   high      : f32,
  hue_low   : f32,   hue_high  : f32,
  sat       : f32,
  lum_low   : f32,   lum_high  : f32
) -> vec3<f32> {
  let t = clamp((val - low) / (high - low), 0.0, 1.0);
  let hue = mix(hue_low, hue_high, t) / 360.0;
  let lum = mix(lum_low, lum_high, t);
  return hsl2rgb(hue, sat, lum);
}

// Soft threshold helper for smoother colour band transitions.
// Using a 2.5-unit transition width reduces hard aliasing and posterisation
// on smooth source gradients while keeping the artistic "cut" character of the
// original cr0p / nunif separation. This is a high-perceived-quality, zero-cost
// improvement (smoothstep is a single ALU op on modern GPUs).
fn softThreshold(v: f32, edge: f32, width: f32) -> f32 {
  return smoothstep(edge - width, edge + width, v);
}

const SOFT_CROP_TW : f32 = 2.2;
const SOBEL_EDGE_BOOST : f32 = 16.0;

fn pixelLuminanceAt(tex: texture_2d<f32>, texSampler: sampler, uv: vec2<f32>) -> f32 {
  let sample = textureSample(tex, texSampler, uv);
  return dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;
}

// Sobel gradient magnitude on BT.709 luminance — boosts edge pixels before band assignment.
fn sobelBoostedLuminance(
  tex: texture_2d<f32>,
  texSampler: sampler,
  uv: vec2<f32>,
  baseLum: f32,
  enabled: f32,
) -> f32 {
  if (enabled < 0.5) { return baseLum; }
  let dims = vec2<f32>(textureDimensions(tex));
  let px = vec2<f32>(1.0 / dims.x, 1.0 / dims.y);
  let tl = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(-px.x, -px.y));
  let tc = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(0.0, -px.y));
  let tr = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(px.x, -px.y));
  let ml = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(-px.x, 0.0));
  let mr = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(px.x, 0.0));
  let bl = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(-px.x, px.y));
  let bc = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(0.0, px.y));
  let br = pixelLuminanceAt(tex, texSampler, uv + vec2<f32>(px.x, px.y));
  let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  let gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  let mag = length(vec2<f32>(gx, gy));
  return clamp(baseLum + SOBEL_EDGE_BOOST * mag, 0.0, 255.0);
}
`;

/** The full colour-helper block: shared maths plus one crop ramp per layer. */
export function emitColorHelpersWgsl(specs: readonly LayerSpec[]): string {
  return `${WGSL_COLOR_HELPER_PRELUDE}${emitCropHelpersWgsl(specs)}\n`;
}

function emitGradientWgsl(spec: LayerSpec, depth: number): string {
  const pad = indent(depth);
  return spec.gradient
    .map((band, i) => {
      const cond = band.bounded
        ? `lum > ${band.lo} && lum <= ${band.hi}`
        : `lum > ${band.lo}`;
      const args = `lum, ${band.lo}, ${band.hi}, ${band.hueLo}, ${band.hueHi}, ${band.sat}, ${band.lumLo}, ${band.lumHi}`;
      const head = i === 0 ? 'if' : 'else if';
      return `${pad}${head} (${cond}) { result = vec4<f32>(band_gradient(${args}), 1.0); }`;
    })
    .join('\n');
}

function emitMaskArmsWgsl(spec: LayerSpec, depth: number): string {
  const pad = indent(depth);
  const arms = spec.fixed.map((band, i) => {
    const head = i === 0 ? `${pad}if` : `${pad}} else if`;
    const body = band.highlight
      ? [
          `${pad}  let g = clamp((grey + (rgb - ${band.lower})) / 255.0, 0.0, 1.0);`,
          `${pad}  result = vec4<f32>(g, g, g, 1.0);`,
        ]
      : [`${pad}  result = vec4<f32>(${band.rgba});`];
    return `${head} (band == ${band.maskBand}u) {\n${body.join('\n')}`;
  });
  arms.push(
    [
      `${pad}} else if (band == ${spec.darkMaskBand}u) {`,
      `${pad}  let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);`,
      `${pad}  result = vec4<f32>(g, g, g, 1.0);`,
      `${pad}}`,
    ].join('\n'),
  );
  return arms.join('\n');
}

function emitSoftArmsWgsl(spec: LayerSpec, depth: number): string {
  const pad = indent(depth);
  const arms = spec.fixed.map((band, i) => {
    const head = i === 0 ? `${pad}if` : `${pad}} else if`;
    if (band.highlight) {
      // The band below the highlight, or the dark tail when the highlight is
      // the only band this layer owns (every group is single-band at the
      // maximum layer count).
      const fade = spec.fixed[i + 1] ?? spec.darkFade;
      return [
        `${head} (rgb > ${band.lower} - tw) {`,
        `${pad}  let t = softThreshold(rgb, ${band.lower}, tw);`,
        `${pad}  let g = clamp((grey + (rgb - ${band.lower})) / 255.0, 0.0, 1.0);`,
        // Fade the highlight grey into the band below it so the seam is not a
        // hard step on smooth gradients.
        `${pad}  let ${fade.name} = vec4<f32>(${fade.rgba});`,
        `${pad}  result = mix(${fade.name}, vec4<f32>(g, g, g, 1.0), t);`,
      ].join('\n');
    }
    const cond = band.upper === null
      ? `rgb > ${band.lower}`
      : `rgb > ${band.lower} && rgb <= ${band.upper}`;
    return `${head} (${cond}) {\n${pad}  result = vec4<f32>(${band.rgba});`;
  });
  arms.push(
    [
      `${pad}} else if (rgb <= ${DARK_RGB_MAX} + tw) {`,
      `${pad}  let t = 1.0 - softThreshold(rgb, ${DARK_RGB_MAX}, tw);`,
      `${pad}  let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);`,
      `${pad}  let ${spec.darkFade.name} = vec4<f32>(${spec.darkFade.rgba});`,
      `${pad}  result = mix(vec4<f32>(g, g, g, 1.0), ${spec.darkFade.name}, t);`,
      `${pad}}`,
    ].join('\n'),
  );
  return arms.join('\n');
}

/** Bindings + uniforms shared by every `band-layer` fragment shader. */
export const BAND_LAYER_HEADER_WGSL = /* wgsl */ `
@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex        : texture_2d<f32>;
@group(0) @binding(4) var classMask  : texture_2d<u32>;
@group(0) @binding(5) var profileLut : texture_2d<f32>;

struct FragUniforms {
  avgLuminance     : f32,
  layerOpacity     : f32,
  colorMode        : f32,
  useMask          : f32,
  sobelEnabled     : f32,
  softCropEnabled  : f32,
  /** 1 = sample the colour-profile LUT instead of the classic band branches. */
  profileMode      : f32,
  /** 1 = lift luminance by the classic lightDark term before LUT lookup. */
  profileLightDark : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;

/**
 * Named colour profile lookup (docs/COLOR_PROFILES.md). Column = preprocessed
 * luminance bucket, row = layer index. \`ceil\` matches the CPU band rule
 * (\`value > min && value <= max\`) exactly for integer band bounds.
 */
fn profileColor(layerIndex : i32, lum : f32) -> vec4<f32> {
  let lift  = select(
    0.0,
    (128.0 + abs(fragUniforms.avgLuminance - 128.0) * 0.5) * 0.5,
    fragUniforms.profileLightDark > 0.5,
  );
  let value = clamp(lum + lift, 0.0, 255.0);
  let col   = clamp(i32(ceil(value)), 0, 255);
  return textureLoad(profileLut, vec2<i32>(col, layerIndex), 0);
}
`;

/** Per-pixel luminance + classification-mask lookup at the top of each main(). */
const BAND_LAYER_PRELUDE_WGSL = /* wgsl */ `
  let sample = textureSample(tex, texSampler, uv);
  let rawLum = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;
  let lum    = sobelBoostedLuminance(tex, texSampler, uv, rawLum, fragUniforms.sobelEnabled);
  let dims   = vec2<f32>(textureDimensions(classMask));
  let maskUv = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.99999994));
  let maskPx = vec2<i32>(maskUv * dims);
  let band   = textureLoad(classMask, maskPx, 0).r;

  var result = vec4<f32>(0.0, 0.0, 0.0, 0.0);
`;

/** `band-layer` node → WGSL fragment shader. */
export function emitBandLayerWgsl(
  spec: LayerSpec,
  colorHelpers: string,
): string {
  return /* wgsl */ `
${colorHelpers}${BAND_LAYER_HEADER_WGSL}
// ─── Fragment: Layer ${spec.index} – ${spec.title} ────────────────────────────
@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
${BAND_LAYER_PRELUDE_WGSL}
  if (fragUniforms.profileMode > 0.5) {
    return profileColor(${spec.index}, lum);
  }

  if (fragUniforms.colorMode == 1.0) {
    // --- CHROMASHIFT GRADIENT ---
${emitGradientWgsl(spec, 2)}
  } else if (fragUniforms.colorMode >= 1.5) {
    // --- CROP MODE (2.0) / CROP NUNIF2 (3.0) ---
    // CR0P (mode 2) maps pixels straight from raw luminance so its bands line
    // up with the go.1ink.us/chromashift reference; NUNIF2 (mode 3) keeps the
    // luminance lift: lum += (128 + |avgLum - 128| / 2) / 2.
    let isNunif2  = fragUniforms.colorMode > 2.5;
    let adj       = lum + (128.0 + abs(fragUniforms.avgLuminance - 128.0) * 0.5) * 0.5;
    let bandLum   = select(lum, adj, isNunif2);
    let nonAlpha  = select(1.0, ${spec.nunif2Alpha}, isNunif2);
    let darkAlpha = select(0.0, 0.1, isNunif2);
    result = ${cropFnName(spec)}(bandLum, fragUniforms.softCropEnabled, nonAlpha, darkAlpha);
  } else {
    // --- ORIGINAL CR0P FIXED ---
    let diff      = (fragUniforms.avgLuminance / 255.0) * 32.0;
    let lightDark = 128.0 + (abs(fragUniforms.avgLuminance - 128.0) / 2.0);
    let rgb       = lum + lightDark / 2.0;
    let grey      = fragUniforms.avgLuminance;
    let useMask   = fragUniforms.useMask > 0.5;

    if (useMask) {
${emitMaskArmsWgsl(spec, 3)}
    } else {
      // Softened thresholds (see softThreshold). The 2.2-unit transition width
      // gives smoother edges on real photos without destroying the distinct
      // colour band identity.
      let tw = 2.2;
${emitSoftArmsWgsl(spec, 3)}
    }
  }

  return result;
}`;
}

const layerList = (count: number) => Array.from({ length: count }, (_, i) => i);

/**
 * Options for the coincidence + decay emitters.
 *
 * `motion` is deliberately opt-in and off by default: with it off the emitted
 * token stream is byte-for-byte what shipped before the temporal term existed,
 * which is what makes `graph/__golden__/coincidence-decay.wgsl` a real
 * pixel-identity guard rather than a snapshot that moves with the code.
 */
export interface CoincidenceDecayOptions {
  /** Emit the motion-field binding, uniforms and temporal term. */
  motion?: boolean;
}

/**
 * Shared motion helpers for the `motion` variant of the coincidence + decay
 * pass. Kept as its own emitted block so the pass-graph work (#154) can lift it
 * into a `motion` node's template without untangling it from the decay maths.
 */
export const WGSL_MOTION_HELPERS = /* wgsl */ `
// Flow angle -> hue, magnitude -> intensity. The frame-difference stage of the
// motion chore writes a zero flow vector, so \`atan2(0, 0)\` pins the hue and
// the mode reads as a magnitude tint until a real flow stage fills gb in.
fn motionDirectionRgb(flow: vec2<f32>, magnitude: f32, gain: f32) -> vec3<f32> {
  let hue = fract(atan2(flow.y, flow.x) / 6.2831853 + 1.0);
  let k = vec3<f32>(0.0, 8.0, 4.0) + hue * 12.0;
  let wedge = clamp(abs((k % 6.0) - 3.0) - 1.0, vec3<f32>(0.0), vec3<f32>(1.0));
  // hsl2rgb at s = 0.9, l = 0.5, scaled by the (gain-weighted) magnitude.
  let rgb = 0.5 - 0.45 + 0.45 * wedge;
  return rgb * clamp(magnitude * gain, 0.0, 1.0);
}

// Motion slows decay locally: a smaller exponent on a sub-1 decay factor means
// less fade per frame, so a moving region holds its trail while a static one
// fades at the usual rate. That difference is what reads as a comet tail.
fn motionDecayScale(magnitude: f32, bias: f32, enabled: bool) -> f32 {
  return select(1.0, max(1.0 - bias * magnitude, 0.0), enabled);
}
`;

/**
 * `coincidence` + `decay` fused into one pass — today's persistence shader.
 *
 * The overlap counter is unrolled over `layerCount` inputs instead of three
 * literal `if` statements, which is the whole reason a fourth colour band used
 * to mean editing this file.
 */
export function emitCoincidenceDecayWgsl(
  layerCount: number,
  options: CoincidenceDecayOptions = {},
): string {
  const motion = options.motion === true;
  const layers = layerList(layerCount);
  const bindings = layers
    .map((i) => `@group(0) @binding(${i + 1}) var layer${i}    : texture_2d<f32>;`)
    .join('\n');
  const samples = layers
    .map((i) => `  let c${i} = textureSample(layer${i}, cSampler, uv);`)
    .join('\n');
  const counts = layers
    .map((i) => `  if (c${i}.a > thresh) { layerCount = layerCount + 1u; }`)
    .join('\n');
  const sums = layers
    .map((i) => `    if (c${i}.a > thresh) { sum = sum + c${i}.rgb; }`)
    .join('\n');
  const variances = layers
    .map((i) => `    if (c${i}.a > thresh) { variance = variance + length(c${i}.rgb - combined); }`)
    .join('\n');
  const dominant = layers
    .map((i) => [
      `      if (c${i}.a > thresh) {`,
      `        let lum = dot(c${i}.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));`,
      `        if (lum > maxLum) { maxLum = lum; dominantLayer = ${i}u; }`,
      '      }',
    ].join('\n'))
    .join('\n');
  const prevBinding = layerCount + 1;
  const uniformBinding = layerCount + 2;
  const motionBinding = layerCount + 3;
  const motionHelpers = motion ? WGSL_MOTION_HELPERS : '';
  const motionTexBinding = motion
    ? `@group(0) @binding(${motionBinding}) var motionTex : texture_2d<f32>;\n`
    : '';
  // The motion variant spends the three tail pads of the original 32-byte
  // uniform block, so both pipelines share one buffer size and one writer.
  const motionUniformFields = motion
    ? '  motionMode  : u32,\n  motionGain  : f32,\n  motionDecayBias : f32,'
    : '  _pad0       : u32,\n  _pad1       : u32,\n  _pad2       : u32,';
  const motionSample = motion
    ? '  let motionSample = textureSample(motionTex, cSampler, uv);\n'
      + '  let motion = clamp(motionSample.r, 0.0, 1.0);\n'
    : '';
  const motionTerm = motion
    ? [
        '',
        '  // Temporal term: the spatial stamp above knows nothing about what',
        '  // changed since the last frame; this is where that enters.',
        '  if (pu.motionMode != 0u && newColor.a > 0.0) {',
        '    if (pu.motionMode == 2u && motion <= 0.0) {',
        '      // gate: a stamp survives only where the frame actually changed,',
        '      // which isolates a live subject from its background with no',
        '      // segmentation model at all.',
        '      newColor = vec4<f32>(0.0);',
        '    } else if (pu.motionMode == 3u) {',
        '      newColor = vec4<f32>(motionDirectionRgb(motionSample.gb, motion, pu.motionGain), newColor.a);',
        '    } else {',
        '      newColor = vec4<f32>(min(newColor.rgb * (1.0 + pu.motionGain * motion), vec3<f32>(1.0)), newColor.a);',
        '    }',
        '  }',
      ].join('\n')
    : '';
  const decayScale = motion
    ? ' * motionDecayScale(motion, pu.motionDecayBias, pu.motionMode != 0u)'
    : '';
  // Diagnostic red channel encodes the dominant layer normalised to [0,1].
  const dominantScale = Math.max(1, layerCount - 1).toFixed(1);
  const fullOverlap = `${layerCount}u`;

  return /* wgsl */ `
@group(0) @binding(0) var cSampler  : sampler;
${bindings}
@group(0) @binding(${prevBinding}) var prevTex   : texture_2d<f32>;
${motionTexBinding}
struct PersistUniforms {
  decayFactor : f32,
  colorThresh : f32,
  stampBoost  : f32,
  tracerMode  : u32,
  peakMode    : u32,
${motionUniformFields}
};
@group(0) @binding(${uniformBinding}) var<uniform> pu : PersistUniforms;
${motionHelpers}
struct FragmentOutputs {
  @location(0) persistence : vec4<f32>,
  @location(1) stampDiagnostic : vec4<f32>,
};

@fragment
fn main(@location(0) uv : vec2<f32>) -> FragmentOutputs {
${samples}
  let prev = textureSample(prevTex, cSampler, uv);
${motionSample}
  // Count how many layers have visible colour at this pixel.
  var layerCount = 0u;
  let thresh = pu.colorThresh;
${counts}

  var newColor = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var dominantLayer = 0u;
  var stampVariance = 0.0;

  // Stamp a tracer ghost when 2+ layers overlap. Skip when every active layer
  // is the same colour — that prevents full-image grey accumulation in dark
  // areas where all layers output identical grey.
  if (layerCount >= 2u) {
    var sum = vec3<f32>(0.0);
${sums}
    let combined = sum / f32(layerCount);

    var variance = 0.0;
${variances}
    stampVariance = variance;

    if (variance > 0.01) {
      var maxLum = 0.0;
${dominant}

      if (pu.tracerMode == 1u) {
        let lum = dot(combined, vec3<f32>(0.2126, 0.7152, 0.0722));
        let boosted = min(lum * pu.stampBoost, 1.0);
        newColor = vec4<f32>(vec3<f32>(boosted), 1.0);
      } else {
        let brightened = min(combined * pu.stampBoost, vec3<f32>(1.0));
        newColor = vec4<f32>(brightened, 1.0);
      }
    }
  }
${motionTerm}
  // Decay modifier: decay faster when actively overlapping, slower otherwise.
  let decayMod = select(${DECAY_WGSL.idleDecayExponent}, ${DECAY_WGSL.overlapDecayExponent}, layerCount >= 2u)${decayScale};
  let effectiveDecay = pow(pu.decayFactor, decayMod);
  var decayed = prev * effectiveDecay;
  if (pu.peakMode == 1u) {
    decayed = vec4<f32>(0.0);
  }

  let outColor = select(decayed, newColor, newColor.a > decayed.a);

  var diag = vec4<f32>(0.0);
  if (newColor.a > 0.5) {
    diag.r = f32(dominantLayer) / ${dominantScale};
    diag.g = select(0.5, 1.0, layerCount >= ${fullOverlap});
    diag.b = clamp(stampVariance * 10.0, 0.0, 1.0);
    diag.a = 1.0;
  }

  var out : FragmentOutputs;
  out.persistence = outColor;
  out.stampDiagnostic = diag;
  return out;
}
`;
}

/**
 * Field order of `CompositorUniforms`, as 4-byte slots. The compositor uniform
 * struct grows with the layer count, so the renderer asks for the layout rather
 * than hard-coding indices.
 */
export function compositorUniformLayout(layerCount: number): Record<string, number> {
  const layout: Record<string, number> = {
    tracerAboveOpacity: 0,
    tracerBelowOpacity: 1,
    layerBlendMode: 2,
    tracerBlendMode: 3,
  };
  let slot = 4;
  for (let i = 0; i < layerCount; i += 1) layout[`layerOpacity${i}`] = slot++;
  for (const name of [
    'diagnosticsOpacity',
    'stampBoost',
    'outputMode',
    'tracerMode',
    'diagnosticsMode',
    'viewportQuarterZoom',
    'halfOverlayAlpha',
    'viewportHalfOverlay',
  ]) {
    layout[name] = slot++;
  }
  return layout;
}

/** Uniform buffer size in bytes for a compositor with `layerCount` layers. */
export function compositorUniformBytes(layerCount: number): number {
  const slots = Object.keys(compositorUniformLayout(layerCount)).length;
  return Math.ceil((slots * 4) / 16) * 16;
}

/**
 * `blend` → the final compositor pass: tracers below, live layers, tracers
 * above, tonemap, optional diagnostics overlay and viewport transforms.
 */
export function emitCompositorWgsl(layerCount: number, blendHelpers: string): string {
  const layers = layerList(layerCount);
  const bindings = layers
    .map((i) => `@group(0) @binding(${i + 1}) var layer${i}         : texture_2d<f32>;`)
    .join('\n');
  const belowBinding = layerCount + 1;
  const aboveBinding = layerCount + 2;
  const uniformBinding = layerCount + 3;
  const opacityFields = layers.map((i) => `  layerOpacity${i}      : f32,`).join('\n');
  const samples = layers
    .map((i) => `  let c${i}      = textureSample(layer${i},       cSampler, sampleUV);`)
    .join('\n');
  const opaque = layers
    .map((i) => `  let c${i}Opaque = scale_premultiplied(c${i}, cu.layerOpacity${i});`)
    .join('\n');
  // Painter's order: the last layer goes down first so layer 0 lands on top,
  // matching the hand-written compositor.
  const stack = [...layers]
    .reverse()
    .map((i) => `  layerCol = blend(layerCol, c${i}Opaque, cu.layerBlendMode);`)
    .join('\n');
  const counts = layers
    .map((i) => `  if (c${i}Opaque.a > thresh) { layerCount = layerCount + 1u; }`)
    .join('\n');
  const sums = layers
    .map((i) => `    if (c${i}Opaque.a > thresh) { sum = sum + c${i}Opaque.rgb; }`)
    .join('\n');
  const variances = layers
    .map((i) => `    if (c${i}Opaque.a > thresh) { variance = variance + length(c${i}Opaque.rgb - combined); }`)
    .join('\n');
  // The diagnostics overlay paints the first three layers' coverage into RGB;
  // layers beyond the third (or missing ones) contribute nothing to the tint.
  const diagChannel = (i: number) =>
    i < layerCount ? `clamp(c${i}Opaque.a, 0.0, 1.0)` : '0.0';
  const fullOverlap = `${layerCount}u`;

  return /* wgsl */ `
${blendHelpers}

@group(0) @binding(0) var cSampler       : sampler;
${bindings}
@group(0) @binding(${belowBinding}) var persistBelow   : texture_2d<f32>;
@group(0) @binding(${aboveBinding}) var persistAbove   : texture_2d<f32>;

struct CompositorUniforms {
  tracerAboveOpacity : f32,
  tracerBelowOpacity : f32,
  layerBlendMode     : u32,
  tracerBlendMode    : u32,
${opacityFields}
  diagnosticsOpacity : f32,
  stampBoost         : f32,
  outputMode         : u32,
  tracerMode         : u32,
  diagnosticsMode    : u32,
  viewportQuarterZoom: u32,
  halfOverlayAlpha   : f32,
  viewportHalfOverlay: u32,
};
@group(0) @binding(${uniformBinding}) var<uniform> cu : CompositorUniforms;

fn viewportSampleUV(uv: vec2<f32>) -> vec2<f32> {
  if (cu.viewportQuarterZoom == 0u) {
    return uv;
  }
  // Magnify the bottom-left quarter (x: 0–0.5, y: 0.5–1.0) to fill the canvas.
  return vec2<f32>(uv.x * 0.5, uv.y * 0.5 + 0.5);
}

fn compositeAt(sampleUV: vec2<f32>) -> vec4<f32> {
${samples}
  let pBelow  = textureSample(persistBelow, cSampler, sampleUV);
  let pAbove  = textureSample(persistAbove, cSampler, sampleUV);

  let pBelowScaled = scale_premultiplied(pBelow, cu.tracerBelowOpacity);
  let pAboveScaled = scale_premultiplied(pAbove, cu.tracerAboveOpacity);

${opaque}

  // 1. Blend the main active layers together.
  var layerCol = vec4<f32>(0.0);
${stack}

  let thresh = 0.05;
  var layerCount = 0u;
${counts}

  var stamp = vec4<f32>(0.0);
  if (layerCount >= 2u) {
    var sum = vec3<f32>(0.0);
${sums}
    let combined = sum / f32(layerCount);

    var variance = 0.0;
${variances}

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

  // 2. Build the final depth stack based on output mode.
  var finalCol = vec4<f32>(0.0);

  if (cu.outputMode == 1u) {
    // Tracer Focus: layers first, then both tracers on top.
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pBelowScaled, cu.tracerBlendMode);
    finalCol = blend(finalCol, pAboveScaled, cu.tracerBlendMode);
  } else if (cu.outputMode == 2u) {
    // Tracer Only: suppress live layers.
    finalCol = blend(finalCol, pBelowScaled, cu.tracerBlendMode);
    finalCol = blend(finalCol, pAboveScaled, cu.tracerBlendMode);
  } else if (cu.outputMode == 3u) {
    finalCol = stamp;
  } else {
    // Mixed (default): Below -> Layers -> Above.
    finalCol = blend(finalCol, pBelowScaled, cu.tracerBlendMode);
    finalCol = alpha_blend(finalCol, layerCol);
    finalCol = blend(finalCol, pAboveScaled, cu.tracerBlendMode);
  }

  // Force opaque output. Without this, no-layer / no-tracer regions produce
  // alpha=0 pixels and some browser/GPU combos let the OS compositor see
  // through the canvas even though alphaMode is 'opaque' on the swapchain.
  // The subtle filmic tonemap distributes energy across the 8-bpc swapchain's
  // quantisation steps, reducing banding out of the 16-bit float pipeline.
  let x = finalCol.rgb * 1.04;                // tiny exposure bias
  var tonemapped = x / (x + vec3<f32>(0.15)); // very soft Reinhard variant
  if (cu.diagnosticsMode == 1u) {
    let diagBase = vec3<f32>(
      ${diagChannel(0)},
      ${diagChannel(1)},
      ${diagChannel(2)}
    );
    var collisionTint = vec3<f32>(0.0);
    if (layerCount == 2u) {
      collisionTint = vec3<f32>(1.0, 0.82, 0.18);
    } else if (layerCount >= ${fullOverlap}) {
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
}

/**
 * `lut` → a standalone colour-profile lookup pass.
 *
 * The default graph folds this into `band-layer` (which samples the LUT inline
 * when `profileMode` is set); this node exists for graphs that grade an
 * arbitrary texture, such as the colour-profile designer's live preview.
 */
export function emitLutWgsl(rows: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var tex        : texture_2d<f32>;
@group(0) @binding(2) var lut        : texture_2d<f32>;

struct LutUniforms {
  /** LUT row to sample (0 .. ${rows - 1}). */
  row      : f32,
  /** 0 = raw luminance, 1 = lift by the classic lightDark term first. */
  lightDark: f32,
  avgLuminance : f32,
  mixAmount    : f32,
};
@group(0) @binding(3) var<uniform> lu : LutUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(tex, texSampler, uv);
  let lum = dot(src.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;
  let lift = select(
    0.0,
    (128.0 + abs(lu.avgLuminance - 128.0) * 0.5) * 0.5,
    lu.lightDark > 0.5,
  );
  let col = clamp(i32(ceil(clamp(lum + lift, 0.0, 255.0))), 0, 255);
  let row = clamp(i32(lu.row), 0, ${rows - 1});
  let graded = textureLoad(lut, vec2<i32>(col, row), 0);
  return mix(src, graded, clamp(lu.mixAmount, 0.0, 1.0));
}
`;
}

/** `warp` → a UV transform: rotate, scale, then optional feedback displacement. */
export function emitWarpWgsl(mode: 'affine' | 'feedback'): string {
  const displace = mode === 'feedback'
    ? '  uv = uv + (textureSample(tex, texSampler, uv).rg - vec2<f32>(0.5)) * wu.displace;'
    : '';
  return /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var tex        : texture_2d<f32>;

struct WarpUniforms {
  angleRad : f32,
  scale    : f32,
  aspect   : f32,
  displace : f32,
};
@group(0) @binding(2) var<uniform> wu : WarpUniforms;

@fragment
fn main(@location(0) inUv : vec2<f32>) -> @location(0) vec4<f32> {
  var uv = inUv;
${displace}
  let c = cos(wu.angleRad);
  let s = sin(wu.angleRad);
  let aspectCorrection = vec2<f32>(1.0, wu.aspect);
  let p = (uv - vec2<f32>(0.5)) * aspectCorrection / max(wu.scale, 0.0001);
  let rotated = vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
  let warped = rotated / aspectCorrection + vec2<f32>(0.5);
  if (warped.x < 0.0 || warped.x > 1.0 || warped.y < 0.0 || warped.y > 1.0) {
    return vec4<f32>(0.0);
  }
  return textureSample(tex, texSampler, warped);
}
`;
}

/**
 * `blur` → one axis of a separable gaussian. The scheduler runs the node twice
 * (horizontal, then vertical) through a transient target, which is exactly the
 * case the texture pool exists to make affordable.
 */
export function emitBlurWgsl(radius: number): string {
  const taps = Math.max(1, Math.round(radius));
  const sigma = Math.max(0.5, taps / 2);
  const weights: number[] = [];
  for (let i = -taps; i <= taps; i += 1) weights.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const total = weights.reduce((a, b) => a + b, 0);
  const samples = weights
    .map((w, i) => {
      const offset = (i - taps).toFixed(1);
      return `  acc = acc + textureSample(tex, texSampler, uv + axis * texel * ${offset}) * ${(w / total).toFixed(6)};`;
    })
    .join('\n');

  return /* wgsl */ `
@group(0) @binding(0) var texSampler : sampler;
@group(0) @binding(1) var tex        : texture_2d<f32>;

struct BlurUniforms {
  /** (1, 0) for the horizontal pass, (0, 1) for the vertical one. */
  axisX : f32,
  axisY : f32,
  _pad0 : f32,
  _pad1 : f32,
};
@group(0) @binding(2) var<uniform> bu : BlurUniforms;

@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
  let texel = 1.0 / vec2<f32>(textureDimensions(tex));
  let axis = vec2<f32>(bu.axisX, bu.axisY);
  var acc = vec4<f32>(0.0);
${samples}
  return acc;
}
`;
}
