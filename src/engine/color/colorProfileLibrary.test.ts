import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLASSIC_PROFILE_ID,
  getBuiltinColorProfile,
  type ColorProfile,
} from './colorProfile';
import {
  colorProfileToJson,
  deleteUserColorProfile,
  importColorProfileJson,
  invalidateColorProfileCache,
  listAllColorProfiles,
  listUserColorProfiles,
  resolveColorProfile,
} from './colorProfileLibrary';

/** Minimal localStorage stand-in — vitest runs these specs in the node env. */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
}

const customProfile = (): ColorProfile => ({
  id: 'artist-neon',
  name: 'Artist Neon',
  version: 1,
  preprocess: { diffScale: 0, lightDarkMode: 'raw' },
  layers: [
    { name: 'warm', bands: [{ name: 'hot', min: 190, max: 255, rgb: [255, 0, 128] }] },
    { name: 'cool', bands: [{ name: 'cold', min: 158, max: 190, rgb: [0, 255, 255] }] },
    { name: 'leaf', bands: [{ name: 'leaf', min: 125, max: 158, rgb: [128, 255, 0] }] },
  ],
});

describe('colour profile library', () => {
  beforeEach(() => {
    installLocalStorage();
    invalidateColorProfileCache();
  });

  it('imports, lists and deletes a user profile', () => {
    const { profile, error } = importColorProfileJson(JSON.stringify(customProfile()));
    expect(error).toBeNull();
    expect(profile?.id).toBe('artist-neon');

    invalidateColorProfileCache();
    expect(listUserColorProfiles().map((p) => p.id)).toEqual(['artist-neon']);
    expect(listAllColorProfiles().map((p) => p.id)).toContain(CLASSIC_PROFILE_ID);

    expect(deleteUserColorProfile('artist-neon')).toEqual([]);
  });

  it('refuses malformed JSON and built-in id collisions', () => {
    expect(importColorProfileJson('nope').error).toMatch(/not valid JSON/);

    const clash = { ...customProfile(), id: CLASSIC_PROFILE_ID };
    expect(importColorProfileJson(JSON.stringify(clash)).error).toMatch(/built-in profile id/);
    expect(listUserColorProfiles()).toEqual([]);
  });

  it('drops stored entries that no longer validate', () => {
    localStorage.setItem(
      'chromashift.colorProfiles',
      JSON.stringify([customProfile(), { id: 'broken', layers: [] }]),
    );
    invalidateColorProfileCache();
    expect(listUserColorProfiles().map((p) => p.id)).toEqual(['artist-neon']);
  });

  it('resolves embedded, built-in and stored profiles, falling back to classic', () => {
    const embedded = customProfile();
    expect(resolveColorProfile('artist-neon', embedded).profile).toBe(embedded);

    expect(resolveColorProfile('diagnostic-grey', null).profile)
      .toBe(getBuiltinColorProfile('diagnostic-grey'));

    importColorProfileJson(JSON.stringify(embedded));
    expect(resolveColorProfile('artist-neon', null).profile.name).toBe('Artist Neon');

    const missing = resolveColorProfile('nowhere', null);
    expect(missing.missing).toBe(true);
    expect(missing.profile.id).toBe(CLASSIC_PROFILE_ID);
  });

  it('exports a profile document without the builtin marker', () => {
    const json = colorProfileToJson(getBuiltinColorProfile('diagnostic-grey')!);
    expect(JSON.parse(json).builtin).toBeUndefined();
    expect(JSON.parse(json).id).toBe('diagnostic-grey');
  });
});
