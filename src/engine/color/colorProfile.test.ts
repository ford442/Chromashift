import { describe, expect, it } from 'vitest';
import bandTable from '../../../shared/band.json';
import {
  BUILTIN_COLOR_PROFILES,
  CLASSIC_COLOR_PROFILE,
  CLASSIC_PROFILE_ID,
  PROFILE_LUT_BYTES,
  PROFILE_LUT_WIDTH,
  buildColorProfileLut,
  colorProfileLookupValue,
  getBuiltinColorProfile,
  getColorProfileLut,
  isClassicProfile,
  parseColorProfile,
  parseColorProfileJson,
  sampleColorProfile,
  type ColorProfile,
} from './colorProfile';
import { fragmentShaderRedOrange } from '../shaders';
import { LAYER_FRAGMENT_SOURCE } from '../webgl/shaders';

const BAND = bandTable.bands;

function classicBand(layer: number, name: string) {
  const band = CLASSIC_COLOR_PROFILE.layers[layer].bands.find((b) => b.name === name);
  if (!band) throw new Error(`missing band ${name}`);
  return band;
}

function lutPixel(lut: Uint8Array, layer: number, value: number): [number, number, number, number] {
  const offset = (layer * PROFILE_LUT_WIDTH + value) * 4;
  return [lut[offset], lut[offset + 1], lut[offset + 2], lut[offset + 3]];
}

describe('built-in colour profiles', () => {
  it('ship classic, soft gradient and diagnostic profiles', () => {
    expect(BUILTIN_COLOR_PROFILES.map((p) => p.id)).toEqual([
      CLASSIC_PROFILE_ID,
      'cr0p-soft-gradient',
      'diagnostic-grey',
    ]);
    for (const profile of BUILTIN_COLOR_PROFILES) {
      expect(profile.layers).toHaveLength(3);
      expect(profile.builtin).toBe(true);
    }
  });

  it('keeps cr0p-classic band bounds in sync with shared/band.json', () => {
    // The canonical thresholds live in shared/band.json; a profile that drifts
    // from them would silently change the default look.
    expect(classicBand(0, 'greyHighlight').min).toBe(BAND.greyHighlight);
    expect(classicBand(0, 'orange').min).toBe(BAND.orange);
    expect(classicBand(0, 'orange').max).toBe(BAND.greyHighlight);
    expect(classicBand(0, 'red').min).toBe(BAND.red);
    expect(classicBand(0, 'red').max).toBe(BAND.orange);
    expect(classicBand(0, 'borderRed').min).toBe(BAND.borderRed);
    expect(classicBand(0, 'borderRed').max).toBe(BAND.red);

    expect(classicBand(1, 'violet').min).toBe(BAND.violet);
    expect(classicBand(1, 'violet').max).toBe(BAND.borderRed);
    expect(classicBand(1, 'blue').min).toBe(BAND.blue);
    expect(classicBand(1, 'blue').max).toBe(BAND.violet);
    expect(classicBand(1, 'borderBlue').min).toBe(BAND.borderBlue);
    expect(classicBand(1, 'borderBlue').max).toBe(BAND.blue);

    expect(classicBand(2, 'green').min).toBe(BAND.green);
    expect(classicBand(2, 'green').max).toBe(BAND.borderBlue);
    expect(classicBand(2, 'yellow').min).toBe(BAND.yellow);
    expect(classicBand(2, 'yellow').max).toBe(BAND.green);
    expect(classicBand(2, 'borderYellow').min).toBe(BAND.borderYellow);
    expect(classicBand(2, 'borderYellow').max).toBe(BAND.yellow);
  });

  it('identifies the classic profile by id or document', () => {
    expect(isClassicProfile(CLASSIC_PROFILE_ID)).toBe(true);
    expect(isClassicProfile(CLASSIC_COLOR_PROFILE)).toBe(true);
    expect(isClassicProfile(getBuiltinColorProfile('diagnostic-grey'))).toBe(false);
    expect(isClassicProfile(null)).toBe(true);
  });
});

describe('profile validation', () => {
  const valid = () => JSON.parse(JSON.stringify(getBuiltinColorProfile('diagnostic-grey')));

  it('accepts a well-formed document', () => {
    const { profile, error } = parseColorProfile(valid());
    expect(error).toBeNull();
    expect(profile?.id).toBe('diagnostic-grey');
  });

  it('rejects a bad id, layer count, band range and rgb tuple', () => {
    expect(parseColorProfile({ ...valid(), id: 'not a valid id!' }).error).toMatch(/id/);
    expect(parseColorProfile({ ...valid(), layers: [] }).error).toMatch(/3 layers/);

    const badRange = valid();
    badRange.layers[0].bands[0].max = badRange.layers[0].bands[0].min;
    expect(parseColorProfile(badRange).error).toMatch(/max must be greater/);

    const badRgb = valid();
    badRgb.layers[1].bands[0].rgb = [255, 0];
    expect(parseColorProfile(badRgb).error).toMatch(/rgb/);

    expect(parseColorProfile(null).error).toMatch(/JSON object/);
    expect(parseColorProfileJson('{oops').error).toMatch(/not valid JSON/);
  });

  it('rejects an unknown grey mode', () => {
    const bad = valid();
    bad.layers[0].bands[0].grey = 'sideways';
    expect(parseColorProfile(bad).error).toMatch(/highlight/);
  });
});

describe('lookup value', () => {
  it('applies the classic lightDark lift and leaves raw luminance alone', () => {
    const classic = colorProfileLookupValue(100, 200, { diffScale: 32, lightDarkMode: 'classic' });
    expect(classic).toBeCloseTo(100 + (128 + 36) / 2, 6);
    expect(colorProfileLookupValue(100, 200, { diffScale: 0, lightDarkMode: 'raw' })).toBe(100);
  });
});

describe('LUT baking', () => {
  it('produces a 256×3 RGBA table', () => {
    const lut = buildColorProfileLut(CLASSIC_COLOR_PROFILE, 128);
    expect(lut.length).toBe(PROFILE_LUT_BYTES);
  });

  it('places diagnostic band steps on the canonical boundaries', () => {
    const profile = getBuiltinColorProfile('diagnostic-grey')!;
    const lut = buildColorProfileLut(profile, 128);

    // Bands are (min, max] — the boundary value itself belongs to the lower band.
    expect(lutPixel(lut, 0, BAND.greyHighlight)).toEqual([216, 216, 216, 255]);
    expect(lutPixel(lut, 0, BAND.greyHighlight + 1)).toEqual([255, 255, 255, 255]);
    expect(lutPixel(lut, 0, BAND.orange + 1)).toEqual([216, 216, 216, 255]);
    // Layer 0 does not cover the violet band — transparent.
    expect(lutPixel(lut, 0, BAND.violet + 1)).toEqual([0, 0, 0, 0]);
    expect(lutPixel(lut, 1, BAND.violet + 1)).toEqual([216, 216, 216, 255]);
    expect(lutPixel(lut, 2, BAND.green + 1)).toEqual([216, 216, 216, 255]);
  });

  it('ramps gradient bands between their endpoints', () => {
    const profile = getBuiltinColorProfile('cr0p-soft-gradient')!;
    const low = sampleColorProfile(profile, 1, 178, 128);
    const high = sampleColorProfile(profile, 1, 190, 128);
    expect(low[2]).toBeGreaterThan(low[0]);          // starts blue-violet
    expect(high[0]).toBeGreaterThan(low[0]);         // ends magenta-violet
    // Outside every band of that layer → transparent.
    expect(sampleColorProfile(profile, 1, 240, 128)[3]).toBe(0);
  });

  it('reproduces the classic shader colours for representative values', () => {
    const avgLum = 160;
    const diff = (avgLum / 255) * 32;

    // Orange band: (255, 128 - diff, 0)
    expect(sampleColorProfile(CLASSIC_COLOR_PROFILE, 0, 220, avgLum)).toEqual([
      1, (128 - diff) / 255, 0, 1,
    ]);
    // Red band: (255 - diff, 0, 0)
    expect(sampleColorProfile(CLASSIC_COLOR_PROFILE, 0, 200, avgLum)).toEqual([
      (255 - diff) / 255, 0, 0, 1,
    ]);
    // Grey highlight: (avgLum + (value - 229)) / 255
    const [r] = sampleColorProfile(CLASSIC_COLOR_PROFILE, 0, 240, avgLum);
    expect(r).toBeCloseTo((avgLum + (240 - BAND.greyHighlight)) / 255, 6);
    // Dark/grey shadow: (avgLum - (value - 128)) / 255
    const [g] = sampleColorProfile(CLASSIC_COLOR_PROFILE, 2, 100, avgLum);
    expect(g).toBeCloseTo((avgLum - (100 - 128)) / 255, 6);
  });

  it('memoizes LUTs per profile + average luminance', () => {
    const profile = getBuiltinColorProfile('diagnostic-grey')!;
    const first = getColorProfileLut(profile, 128);
    expect(getColorProfileLut(profile, 128)).toBe(first);
    // Sub-bucket jitter must not churn the GPU upload.
    expect(getColorProfileLut(profile, 128.1)).toBe(first);
    expect(getColorProfileLut(profile, 200)).not.toBe(first);
  });
});

describe('shader LUT path', () => {
  it('is generated once per backend from the shared lookup rule', () => {
    for (const source of [fragmentShaderRedOrange, LAYER_FRAGMENT_SOURCE]) {
      expect(source).toContain('profileColor');
      expect(source).toContain('ceil(');
    }
    expect(fragmentShaderRedOrange).toContain('textureLoad(profileLut');
    expect(LAYER_FRAGMENT_SOURCE).toContain('texelFetch(u_profileLut');
  });

  it('agrees with the CPU sampler on which LUT column a value reads', () => {
    // Shader column = clamp(ceil(value), 0, 255); the CPU LUT is baked at
    // integer values, so both land in the same band for integer bounds.
    const profile = getBuiltinColorProfile('diagnostic-grey') as ColorProfile;
    const lut = buildColorProfileLut(profile, 128);
    for (const value of [125.4, 145.9, 158.01, 209.5, 229.0]) {
      const col = Math.min(255, Math.max(0, Math.ceil(value)));
      const fromLut = lutPixel(lut, 2, col);
      const direct = sampleColorProfile(profile, 2, value, 128);
      expect(fromLut[0]).toBe(Math.round(direct[0] * 255));
      expect(fromLut[3]).toBe(Math.round(direct[3] * 255));
    }
  });
});
