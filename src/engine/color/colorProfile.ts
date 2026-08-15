import builtinProfileTable from '../../../shared/colorProfiles.json';

/**
 * Named colour profiles — see docs/COLOR_PROFILES.md.
 *
 * A profile maps a preprocessed luminance value (`colorProfileLookupValue`) to a
 * per-layer RGBA colour. Rendering uses one of two paths (hybrid strategy C):
 *
 *   - `cr0p-classic` keeps the existing branchy WGSL/GLSL shader path, so the
 *     default look is bit-for-bit what it was before profiles existed.
 *   - every other profile is baked into a 256×3 RGBA LUT (`buildColorProfileLut`)
 *     that both renderers sample with `textureLoad` / `texelFetch`. One shader,
 *     no pipeline recreation, and the artist table never forks the shaders.
 */

/** How the lookup value is derived from raw luminance. */
export type LightDarkMode = 'classic' | 'raw';

export interface ColorProfilePreprocess {
  /** Scales the avgLuminance-driven desaturation term (`diff`). */
  diffScale: number;
  /**
   * `classic` lifts luminance by `(128 + |avgLum - 128| / 2) / 2` before band
   * lookup (original cr0p behaviour). `raw` uses luminance unchanged.
   */
  lightDarkMode: LightDarkMode;
}

export type Rgb = [number, number, number];

export interface ColorProfileBand {
  name: string;
  /** Lower bound, exclusive (`value > min`). */
  min: number;
  /** Upper bound, inclusive (`value <= max`). */
  max: number;
  /** Band colour, 0–255 per channel. */
  rgb: Rgb;
  /** When present, the band ramps linearly from `rgb` at `min` to `rgbTo` at `max`. */
  rgbTo?: Rgb;
  /** Band opacity, 0–1 (default 1). */
  alpha?: number;
  /** Per-channel multiplier for the avgLuminance `diff` term, subtracted from `rgb`. */
  diffTint?: Rgb;
  /** Grey ramps driven by avgLuminance instead of a fixed colour. */
  grey?: 'highlight' | 'shadow';
  /** Pivot for `grey: "shadow"` (default 128). Highlight bands pivot on `min`. */
  greyPivot?: number;
}

export interface ColorProfileLayer {
  name: string;
  bands: ColorProfileBand[];
}

export interface ColorProfile {
  id: string;
  name: string;
  version: number;
  builtin?: boolean;
  description?: string;
  preprocess: ColorProfilePreprocess;
  /** Exactly three layers, matching the three colour-separation passes. */
  layers: [ColorProfileLayer, ColorProfileLayer, ColorProfileLayer];
}

export const CLASSIC_PROFILE_ID = 'cr0p-classic';

/** LUT geometry — 256 luminance buckets × 3 layer rows, RGBA8. */
export const PROFILE_LUT_WIDTH = 256;
export const PROFILE_LUT_HEIGHT = 3;
export const PROFILE_LUT_BYTES = PROFILE_LUT_WIDTH * PROFILE_LUT_HEIGHT * 4;

export type ColorProfileParseResult =
  | { profile: ColorProfile; error: null }
  | { profile: null; error: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseRgb(value: unknown, label: string): Rgb | string {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
    return `${label} must be an array of three numbers`;
  }
  return value.map((c) => Math.min(255, Math.max(0, c))) as Rgb;
}

function parseBand(raw: unknown, label: string): ColorProfileBand | string {
  if (typeof raw !== 'object' || raw === null) return `${label} must be an object`;
  const band = raw as Record<string, unknown>;

  if (typeof band.name !== 'string' || !band.name) return `${label}.name must be a non-empty string`;
  if (!isFiniteNumber(band.min) || !isFiniteNumber(band.max)) {
    return `${label} needs numeric min and max`;
  }
  if (band.max <= band.min) return `${label}: max must be greater than min`;

  const rgb = parseRgb(band.rgb, `${label}.rgb`);
  if (typeof rgb === 'string') return rgb;

  const parsed: ColorProfileBand = { name: band.name, min: band.min, max: band.max, rgb };

  if (band.rgbTo !== undefined) {
    const rgbTo = parseRgb(band.rgbTo, `${label}.rgbTo`);
    if (typeof rgbTo === 'string') return rgbTo;
    parsed.rgbTo = rgbTo;
  }
  if (band.alpha !== undefined) {
    if (!isFiniteNumber(band.alpha)) return `${label}.alpha must be a number`;
    parsed.alpha = Math.min(1, Math.max(0, band.alpha));
  }
  if (band.diffTint !== undefined) {
    const tint = parseRgb(band.diffTint, `${label}.diffTint`);
    if (typeof tint === 'string') return tint;
    parsed.diffTint = tint;
  }
  if (band.grey !== undefined) {
    if (band.grey !== 'highlight' && band.grey !== 'shadow') {
      return `${label}.grey must be "highlight" or "shadow"`;
    }
    parsed.grey = band.grey;
  }
  if (band.greyPivot !== undefined) {
    if (!isFiniteNumber(band.greyPivot)) return `${label}.greyPivot must be a number`;
    parsed.greyPivot = band.greyPivot;
  }

  return parsed;
}

/**
 * Validate an untrusted colour-profile document (imported JSON, localStorage,
 * an embedded preset table). Returns a friendly error instead of throwing.
 */
export function parseColorProfile(raw: unknown): ColorProfileParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { profile: null, error: 'Profile must be a JSON object' };
  }
  const doc = raw as Record<string, unknown>;

  if (typeof doc.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(doc.id)) {
    return { profile: null, error: 'Profile id must be 1–64 chars of letters, digits, dot, dash or underscore' };
  }
  if (doc.name !== undefined && typeof doc.name !== 'string') {
    return { profile: null, error: 'Profile name must be a string' };
  }
  if (doc.version !== undefined && !isFiniteNumber(doc.version)) {
    return { profile: null, error: 'Profile version must be a number' };
  }

  const preprocessRaw = (doc.preprocess ?? {}) as Record<string, unknown>;
  if (typeof preprocessRaw !== 'object' || preprocessRaw === null) {
    return { profile: null, error: 'Profile preprocess must be an object' };
  }
  const lightDarkMode = preprocessRaw.lightDarkMode ?? 'classic';
  if (lightDarkMode !== 'classic' && lightDarkMode !== 'raw') {
    return { profile: null, error: 'preprocess.lightDarkMode must be "classic" or "raw"' };
  }
  const diffScale = preprocessRaw.diffScale ?? 32;
  if (!isFiniteNumber(diffScale)) {
    return { profile: null, error: 'preprocess.diffScale must be a number' };
  }

  if (!Array.isArray(doc.layers) || doc.layers.length !== 3) {
    return { profile: null, error: 'Profile must have exactly 3 layers' };
  }

  const layers: ColorProfileLayer[] = [];
  for (let i = 0; i < 3; i += 1) {
    const layerRaw = doc.layers[i] as Record<string, unknown> | null;
    if (typeof layerRaw !== 'object' || layerRaw === null) {
      return { profile: null, error: `layers[${i}] must be an object` };
    }
    if (!Array.isArray(layerRaw.bands) || layerRaw.bands.length === 0) {
      return { profile: null, error: `layers[${i}].bands must be a non-empty array` };
    }
    const bands: ColorProfileBand[] = [];
    for (let b = 0; b < layerRaw.bands.length; b += 1) {
      const band = parseBand(layerRaw.bands[b], `layers[${i}].bands[${b}]`);
      if (typeof band === 'string') return { profile: null, error: band };
      bands.push(band);
    }
    layers.push({
      name: typeof layerRaw.name === 'string' && layerRaw.name ? layerRaw.name : `layer${i}`,
      bands,
    });
  }

  return {
    profile: {
      id: doc.id,
      name: typeof doc.name === 'string' && doc.name ? doc.name : doc.id,
      version: isFiniteNumber(doc.version) ? doc.version : 1,
      builtin: doc.builtin === true,
      description: typeof doc.description === 'string' ? doc.description : undefined,
      preprocess: { diffScale, lightDarkMode },
      layers: layers as ColorProfile['layers'],
    },
    error: null,
  };
}

/** Parse a profile from a JSON string (file import / URL payload). */
export function parseColorProfileJson(json: string): ColorProfileParseResult {
  try {
    return parseColorProfile(JSON.parse(json));
  } catch {
    return { profile: null, error: 'File is not valid JSON' };
  }
}

function loadBuiltins(): ColorProfile[] {
  const profiles: ColorProfile[] = [];
  for (const raw of builtinProfileTable.profiles) {
    const { profile, error } = parseColorProfile(raw);
    if (!profile) {
      // shared/colorProfiles.json is checked in and covered by colorProfile.test.ts;
      // a failure here means the build shipped a malformed table.
      throw new Error(`Invalid built-in colour profile: ${error}`);
    }
    profiles.push({ ...profile, builtin: true });
  }
  return profiles;
}

/** Built-in profiles, in menu order (classic first). */
export const BUILTIN_COLOR_PROFILES: readonly ColorProfile[] = loadBuiltins();

export function getBuiltinColorProfile(id: string): ColorProfile | null {
  return BUILTIN_COLOR_PROFILES.find((p) => p.id === id) ?? null;
}

export const CLASSIC_COLOR_PROFILE: ColorProfile = (() => {
  const classic = getBuiltinColorProfile(CLASSIC_PROFILE_ID);
  if (!classic) throw new Error(`Missing built-in profile ${CLASSIC_PROFILE_ID}`);
  return classic;
})();

export function isClassicProfile(profile: ColorProfile | string | null | undefined): boolean {
  if (!profile) return true;
  return (typeof profile === 'string' ? profile : profile.id) === CLASSIC_PROFILE_ID;
}

/** `diff` — the avgLuminance-driven desaturation term. */
export function colorProfileDiff(avgLum: number, preprocess: ColorProfilePreprocess): number {
  return (avgLum / 255) * preprocess.diffScale;
}

/**
 * Preprocessed luminance used for band lookup. Mirrors the `rgb` value in the
 * classic layer shaders when `lightDarkMode` is `classic`.
 */
export function colorProfileLookupValue(
  lum: number,
  avgLum: number,
  preprocess: ColorProfilePreprocess,
): number {
  if (preprocess.lightDarkMode === 'raw') return lum;
  return lum + (128 + Math.abs(avgLum - 128) / 2) / 2;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Colour for one layer at a given lookup value, as RGBA in 0–1.
 * Returns transparent black when no band of that layer covers the value.
 */
export function sampleColorProfile(
  profile: ColorProfile,
  layerIndex: number,
  value: number,
  avgLum: number,
): [number, number, number, number] {
  const layer = profile.layers[layerIndex];
  if (!layer) return [0, 0, 0, 0];
  const diff = colorProfileDiff(avgLum, profile.preprocess);

  for (const band of layer.bands) {
    if (value <= band.min || value > band.max) continue;

    const alpha = band.alpha ?? 1;

    if (band.grey === 'highlight') {
      const g = clamp01((avgLum + (value - band.min)) / 255);
      return [g, g, g, alpha];
    }
    if (band.grey === 'shadow') {
      const g = clamp01((avgLum - (value - (band.greyPivot ?? 128))) / 255);
      return [g, g, g, alpha];
    }

    const t = band.rgbTo ? clamp01((value - band.min) / (band.max - band.min)) : 0;
    const out: [number, number, number, number] = [0, 0, 0, alpha];
    for (let c = 0; c < 3; c += 1) {
      const base = band.rgbTo
        ? band.rgb[c] + (band.rgbTo[c] - band.rgb[c]) * t
        : band.rgb[c];
      const tinted = band.diffTint ? base - diff * band.diffTint[c] : base;
      out[c] = clamp01(tinted / 255);
    }
    return out;
  }

  return [0, 0, 0, 0];
}

/**
 * Bake a profile into a 256×3 RGBA8 LUT. Column = lookup value bucket
 * (0–255), row = layer index. Shaders index it with the same rounded value.
 */
export function buildColorProfileLut(profile: ColorProfile, avgLum: number): Uint8Array {
  const lut = new Uint8Array(PROFILE_LUT_BYTES);
  for (let layer = 0; layer < PROFILE_LUT_HEIGHT; layer += 1) {
    for (let value = 0; value < PROFILE_LUT_WIDTH; value += 1) {
      const [r, g, b, a] = sampleColorProfile(profile, layer, value, avgLum);
      const offset = (layer * PROFILE_LUT_WIDTH + value) * 4;
      lut[offset] = Math.round(r * 255);
      lut[offset + 1] = Math.round(g * 255);
      lut[offset + 2] = Math.round(b * 255);
      lut[offset + 3] = Math.round(a * 255);
    }
  }
  return lut;
}

interface LutCacheEntry {
  key: string;
  lut: Uint8Array;
}

const LUT_CACHE_LIMIT = 8;
const lutCache: LutCacheEntry[] = [];

/**
 * Memoized {@link buildColorProfileLut}. `buildRendererState` calls this every
 * frame, so the array identity stays stable until the profile or average
 * luminance actually changes — renderers upload only on identity change.
 */
export function getColorProfileLut(profile: ColorProfile, avgLum: number): Uint8Array {
  // Quantize avgLum: a LUT bucket can't resolve finer than half a unit anyway.
  const quantized = Math.round(avgLum * 2) / 2;
  const key = `${profile.id}@${profile.version}:${quantized}`;
  const hit = lutCache.find((entry) => entry.key === key);
  if (hit) return hit.lut;

  const lut = buildColorProfileLut(profile, quantized);
  lutCache.unshift({ key, lut });
  if (lutCache.length > LUT_CACHE_LIMIT) lutCache.length = LUT_CACHE_LIMIT;
  return lut;
}
