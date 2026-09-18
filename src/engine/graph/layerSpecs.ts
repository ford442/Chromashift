import { BAND, type BandName } from '../math/bandClassification';
import { BAND_SHADER_FLOAT } from '../shaders/bandLiterals';

const B = BAND_SHADER_FLOAT;
const BAND_NAMES = Object.keys(BAND) as BandName[];

/**
 * Per-layer band descriptors — the data the `band-layer` templates read instead
 * of three hand-written shaders.
 *
 * A "layer" is a contiguous run of canonical bands (shared/band.json) rendered
 * with its own colour ramp. The three shipped layers are described by
 * {@link CANONICAL_LAYER_SPECS}; any other layer count is derived by
 * {@link buildLayerSpecs}, which partitions the same band table.
 */

/** One `else if` arm of the CR0P-fixed colour path. */
export interface FixedBand {
  /** Exclusive lower bound: `rgb > lower`. */
  lower: string;
  /** Inclusive upper bound (`rgb <= upper`); `null` for a layer's open top band. */
  upper: string | null;
  /** vec4 component list, e.g. `1.0, (128.0 - diff) / 255.0, 0.0, 1.0`. */
  rgba: string;
  /** Classification-mask band index this arm corresponds to. */
  maskBand: number;
  /** Shader-local name used when the dark tail fades into this band. */
  name: string;
  /** Luminance-tracking grey highlight (band 0) rather than a fixed colour. */
  highlight?: boolean;
}

/** One arm of the CROP / CROP-NUNIF2 colour path. */
export interface CropBand {
  name: string;
  /**
   * Local name used by the GLSL `cropColor` switch when it differs from the
   * WGSL spelling. Carried as data so the backend-parity test can stay exact
   * instead of ignoring identifier renames.
   */
  glslName?: string;
  /** vec3 component list, e.g. `0.753, 0.753, 0.753`. */
  rgb: string;
  /** Inclusive lower bound: `bandLum >= lower`. */
  lower: string;
}

/** One arm of the Chromashift gradient path. */
export interface GradientBand {
  lo: string;
  hi: string;
  hueLo: string;
  hueHi: string;
  sat: string;
  lumLo: string;
  lumHi: string;
  /** Emit `lum > lo && lum <= hi` instead of `lum > lo`. */
  bounded: boolean;
}

export interface LayerSpec {
  index: number;
  /** Stable id used for node ids and debugging, e.g. `red-orange`. */
  id: string;
  /** Human-readable band name for shader section comments. */
  title: string;
  fixed: FixedBand[];
  /** Band the dark/grey tail fades into — the layer's lowest colour band. */
  darkFade: { name: string; rgba: string };
  /** Classification-mask index for the dark/grey band (always the table tail). */
  darkMaskBand: number;
  crop: CropBand[];
  /** Upper bound of the crop range (`bandLum < cropUpper`); `null` for an open top. */
  cropUpper: string | null;
  /** Per-layer alpha used by CROP NUNIF2 (mode 3). */
  nunif2Alpha: string;
  gradient: GradientBand[];
}

/** Mask index of the dark/grey band — one past the last threshold. */
export const DARK_MASK_BAND = BAND_NAMES.length;

/**
 * Upper bound on a session's layer count.
 *
 * A layer owns a contiguous run of the canonical bands in shared/band.json, so
 * there can never be more layers than there are bands — past ten, a layer would
 * have to invent a threshold, which {@link buildLayerSpecs} refuses to do.
 */
export const MAX_LAYER_COUNT = BAND_NAMES.length;

/**
 * Throw unless `layerCount` is an integer in `[1, MAX_LAYER_COUNT]`.
 *
 * The single gate every layer-count entry point shares — `buildLayerSpecs`,
 * `buildDefaultGraph`, and the reducer's `layers/setCount` — so an out-of-range
 * count fails at the boundary instead of producing a half-built graph.
 */
export function assertLayerCount(layerCount: number): number {
  if (!Number.isInteger(layerCount) || layerCount < 1) {
    throw new RangeError(`layerCount must be a positive integer, got ${layerCount}.`);
  }
  if (layerCount > MAX_LAYER_COUNT) {
    throw new RangeError(
      `layerCount ${layerCount} exceeds the ${MAX_LAYER_COUNT} canonical bands in shared/band.json.`,
    );
  }
  return layerCount;
}

/** Clamp an untrusted count (a preset file, a URL) into range instead of throwing. */
export function clampLayerCount(layerCount: unknown): number {
  const value = typeof layerCount === 'number' && Number.isFinite(layerCount)
    ? Math.round(layerCount)
    : CANONICAL_LAYER_COUNT;
  return Math.min(Math.max(value, 1), MAX_LAYER_COUNT);
}

/** `rgb <= this` is the dark/grey tail (borderYellow + 1). */
export const DARK_RGB_MAX = (BAND.borderYellow + 1).toFixed(1);

const ORANGE_RGBA = `1.0, (128.0 - diff) / 255.0, 0.0, 1.0`;
const RED_RGBA = `(255.0 - diff) / 255.0, 0.0, 0.0, 1.0`;
const BORDER_RED_RGBA = `1.0, 0.0, 0.0, 1.0`;
const VIOLET_RGBA = `(128.0 - diff) / 255.0, 0.0, 1.0, 1.0`;
const BLUE_RGBA = `0.0, 0.0, (255.0 - diff) / 255.0, 1.0`;
const BORDER_BLUE_RGBA = `0.0, 0.0, 1.0, 1.0`;
const GREEN_RGBA = `0.0, (255.0 - diff) / 255.0, 0.0, 1.0`;
const YELLOW_RGBA = `1.0, (255.0 - diff) / 255.0, 0.0, 1.0`;
const BORDER_YELLOW_RGBA = `1.0, 1.0, 0.0, 1.0`;

/**
 * The three shipped layers, transcribed from the hand-written shaders they
 * replace. These are data, not defaults: `buildLayerSpecs(3)` returns exactly
 * this table so the default graph reproduces today's look by construction.
 */
export const CANONICAL_LAYER_SPECS: readonly LayerSpec[] = [
  {
    index: 0,
    id: 'red-orange',
    title: 'Red / Orange',
    fixed: [
      { lower: B.greyHighlight, upper: null, rgba: '', maskBand: 0, name: 'greyHighlight', highlight: true },
      { lower: B.orange, upper: null, rgba: ORANGE_RGBA, maskBand: 1, name: 'orange' },
      { lower: B.red, upper: null, rgba: RED_RGBA, maskBand: 2, name: 'red' },
      { lower: B.borderRed, upper: null, rgba: BORDER_RED_RGBA, maskBand: 3, name: 'borderRed' },
    ],
    darkFade: { name: 'borderRed', rgba: BORDER_RED_RGBA },
    darkMaskBand: DARK_MASK_BAND,
    crop: [
      { name: 'grey', rgb: '0.753, 0.753, 0.753', lower: B.greyHighlight },
      { name: 'orange', rgb: '1.0, 0.627, 0.0', lower: B.orange },
      { name: 'red', rgb: '1.0, 0.0, 0.0', lower: B.borderRed },
    ],
    cropUpper: null,
    nunif2Alpha: '0.5',
    gradient: [
      { lo: B.greyHighlight, hi: '255.0', hueLo: '45.0', hueHi: '60.0', sat: '0.3', lumLo: '0.80', lumHi: '1.0', bounded: false },
      { lo: B.orange, hi: B.greyHighlight, hueLo: '10.0', hueHi: '40.0', sat: '1.0', lumLo: '0.50', lumHi: '0.65', bounded: false },
      { lo: B.borderRed, hi: B.orange, hueLo: '0.0', hueHi: '10.0', sat: '1.0', lumLo: '0.40', lumHi: '0.55', bounded: false },
    ],
  },
  {
    index: 1,
    id: 'violet-blue',
    title: 'Violet / Blue',
    fixed: [
      { lower: B.violet, upper: B.borderRed, rgba: VIOLET_RGBA, maskBand: 4, name: 'violet' },
      { lower: B.blue, upper: B.violet, rgba: BLUE_RGBA, maskBand: 5, name: 'blue' },
      { lower: B.borderBlue, upper: B.blue, rgba: BORDER_BLUE_RGBA, maskBand: 6, name: 'borderBlue' },
    ],
    darkFade: { name: 'borderBlue', rgba: BORDER_BLUE_RGBA },
    darkMaskBand: DARK_MASK_BAND,
    crop: [
      { name: 'violet', rgb: '0.502, 0.0, 0.502', lower: B.violet },
      { name: 'blue', rgb: '0.0, 0.0, 0.545', lower: B.blue },
      { name: 'borderBlue', glslName: 'border', rgb: '0.0, 0.0, 1.0', lower: B.borderBlue },
    ],
    cropUpper: B.borderRed,
    nunif2Alpha: '0.777',
    gradient: [
      { lo: B.violet, hi: B.borderRed, hueLo: '255.0', hueHi: '290.0', sat: '1.0', lumLo: '0.40', lumHi: '0.55', bounded: true },
      { lo: B.borderBlue, hi: B.violet, hueLo: '220.0', hueHi: '255.0', sat: '1.0', lumLo: '0.38', lumHi: '0.50', bounded: true },
    ],
  },
  {
    index: 2,
    id: 'green-yellow',
    title: 'Green / Yellow',
    fixed: [
      { lower: B.green, upper: B.borderBlue, rgba: GREEN_RGBA, maskBand: 7, name: 'green' },
      { lower: B.yellow, upper: B.green, rgba: YELLOW_RGBA, maskBand: 8, name: 'yellow' },
      { lower: B.borderYellow, upper: B.yellow, rgba: BORDER_YELLOW_RGBA, maskBand: 9, name: 'borderYellow' },
    ],
    darkFade: { name: 'borderYellow', rgba: BORDER_YELLOW_RGBA },
    darkMaskBand: DARK_MASK_BAND,
    crop: [
      { name: 'green', rgb: '0.0, 0.502, 0.0', lower: B.green },
      { name: 'yellow', rgb: '0.502, 1.0, 0.0', lower: B.yellow },
      { name: 'borderYellow', glslName: 'border', rgb: '1.0, 1.0, 0.0', lower: B.borderYellow },
    ],
    cropUpper: B.borderBlue,
    nunif2Alpha: '0.777',
    gradient: [
      { lo: B.green, hi: B.borderBlue, hueLo: '90.0', hueHi: '130.0', sat: '1.0', lumLo: '0.38', lumHi: '0.50', bounded: true },
      { lo: B.borderYellow, hi: B.green, hueLo: '50.0', hueHi: '90.0', sat: '1.0', lumLo: '0.40', lumHi: '0.52', bounded: true },
    ],
  },
];

export const CANONICAL_LAYER_COUNT = CANONICAL_LAYER_SPECS.length;

/** Partition `total` band indices into `groups` contiguous runs, largest first. */
function partition(total: number, groups: number): number[][] {
  const base = Math.floor(total / groups);
  const remainder = total % groups;
  const out: number[][] = [];
  let cursor = 0;
  for (let g = 0; g < groups; g += 1) {
    const size = base + (g < remainder ? 1 : 0);
    out.push(Array.from({ length: size }, (_, i) => cursor + i));
    cursor += size;
  }
  return out;
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => {
    const k = (n + (h / 30)) % 12;
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  }) as [number, number, number];
}

function rgbLiteral(h: number, s: number, l: number): string {
  return hsl(h, s, l).map((c) => c.toFixed(3)).join(', ');
}

/**
 * Derive a layer table for an arbitrary layer count.
 *
 * The canonical three are returned verbatim (so the default graph is
 * bit-for-bit the shipped look); any other count partitions the same ten
 * canonical thresholds into contiguous runs and assigns each run an evenly
 * spaced hue ramp. The band thresholds themselves are never invented — they
 * always come from shared/band.json, which keeps the TS/WGSL/GLSL/C++ parity
 * guarantee in bandTable.test.ts intact.
 */
export function buildLayerSpecs(layerCount: number): readonly LayerSpec[] {
  assertLayerCount(layerCount);
  if (layerCount === CANONICAL_LAYER_COUNT) return CANONICAL_LAYER_SPECS;

  return partition(BAND_NAMES.length, layerCount).map((bandIndices, index) => {
    const hue = (360 * index) / layerCount;
    const names = bandIndices.map((i) => BAND_NAMES[i]);
    const lowers = names.map((name) => B[name]);
    // Upper bound of the layer's top band: the threshold just above it, or open
    // for the layer that owns band 0.
    const topIndex = bandIndices[0];
    const cropUpper = topIndex === 0 ? null : B[BAND_NAMES[topIndex - 1]];

    const fixed: FixedBand[] = bandIndices.map((bandIndex, i) => {
      const name = `${names[i]}`;
      const upper = i === 0 ? cropUpper : B[names[i - 1]];
      const lightness = 0.55 - 0.1 * i;
      if (bandIndex === 0) {
        return { lower: lowers[i], upper: null, rgba: '', maskBand: 0, name, highlight: true };
      }
      return {
        lower: lowers[i],
        upper,
        rgba: `${rgbLiteral(hue + 10 * i, 1.0, lightness)}, 1.0`,
        maskBand: bandIndex,
        name,
      };
    });

    const lowest = fixed[fixed.length - 1];
    return {
      index,
      id: `band-${index}`,
      title: `Band group ${index}`,
      fixed,
      darkFade: { name: lowest.name, rgba: lowest.rgba || `${rgbLiteral(hue, 1.0, 0.5)}, 1.0` },
      darkMaskBand: DARK_MASK_BAND,
      crop: bandIndices.map((_, i) => ({
        name: names[i],
        rgb: rgbLiteral(hue + 10 * i, 1.0, 0.55 - 0.1 * i),
        lower: lowers[i],
      })),
      cropUpper,
      nunif2Alpha: index === 0 ? '0.5' : '0.777',
      // One arm per band, highest first, so a group that owns a single band
      // still renders in gradient mode instead of staying fully transparent.
      gradient: bandIndices.map((_, i) => ({
        lo: lowers[i],
        hi: i === 0 ? cropUpper ?? '255.0' : lowers[i - 1],
        hueLo: (hue + 10 * i).toFixed(1),
        hueHi: (hue + 10 * (i + 1)).toFixed(1),
        sat: '1.0',
        lumLo: '0.40',
        lumHi: '0.55',
        bounded: cropUpper !== null,
      })),
    };
  });
}
