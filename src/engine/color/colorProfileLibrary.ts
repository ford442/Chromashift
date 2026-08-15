import {
  BUILTIN_COLOR_PROFILES,
  CLASSIC_COLOR_PROFILE,
  getBuiltinColorProfile,
  parseColorProfile,
  parseColorProfileJson,
  type ColorProfile,
} from './colorProfile';

/**
 * User colour profiles, stored in localStorage next to the preset library
 * (`chromashift.presets`). Imported JSON is validated before it is stored, so a
 * malformed profile can never reach the renderer.
 */

const STORAGE_KEY = 'chromashift.colorProfiles';

let cache: ColorProfile[] | null = null;

function readAll(): ColorProfile[] {
  if (cache) return cache;
  let profiles: ColorProfile[] = [];
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        profiles = parsed
          .map((entry) => parseColorProfile(entry).profile)
          .filter((profile): profile is ColorProfile => profile !== null)
          // A stored profile must never shadow a built-in id.
          .filter((profile) => getBuiltinColorProfile(profile.id) === null);
      }
    }
  } catch {
    profiles = [];
  }
  cache = profiles;
  return profiles;
}

function writeAll(profiles: ColorProfile[]): boolean {
  cache = profiles;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
    return true;
  } catch {
    return false;
  }
}

/** Drop the in-memory cache (tests, or a library edited in another tab). */
export function invalidateColorProfileCache(): void {
  cache = null;
}

export function listUserColorProfiles(): ColorProfile[] {
  return [...readAll()];
}

/** Built-ins followed by user profiles — menu order. */
export function listAllColorProfiles(): ColorProfile[] {
  return [...BUILTIN_COLOR_PROFILES, ...readAll()];
}

export function getUserColorProfile(id: string): ColorProfile | null {
  return readAll().find((profile) => profile.id === id) ?? null;
}

export function saveUserColorProfile(profile: ColorProfile): ColorProfile[] {
  const others = readAll().filter((entry) => entry.id !== profile.id);
  writeAll([{ ...profile, builtin: false }, ...others]);
  return listUserColorProfiles();
}

export function deleteUserColorProfile(id: string): ColorProfile[] {
  writeAll(readAll().filter((profile) => profile.id !== id));
  return listUserColorProfiles();
}

export interface ImportColorProfileResult {
  profile: ColorProfile | null;
  error: string | null;
}

/** Validate and store an imported profile document (JSON text). */
export function importColorProfileJson(json: string): ImportColorProfileResult {
  const { profile, error } = parseColorProfileJson(json);
  if (!profile) return { profile: null, error };
  if (getBuiltinColorProfile(profile.id)) {
    return { profile: null, error: `“${profile.id}” is a built-in profile id — rename it before importing.` };
  }
  saveUserColorProfile(profile);
  return { profile, error: null };
}

export function colorProfileToJson(profile: ColorProfile, pretty = true): string {
  const { builtin: _builtin, ...doc } = profile;
  void _builtin;
  return JSON.stringify(doc, null, pretty ? 2 : undefined);
}

export interface ResolvedColorProfile {
  profile: ColorProfile;
  /** True when the requested id could not be found and Classic was substituted. */
  missing: boolean;
}

/**
 * Resolve the active profile for an id, preferring a document embedded in the
 * preset (so a shared file works without the recipient's library), then
 * built-ins, then the local library. Falls back to Classic.
 */
export function resolveColorProfile(
  id: string | null | undefined,
  embedded?: ColorProfile | null,
): ResolvedColorProfile {
  if (!id) return { profile: CLASSIC_COLOR_PROFILE, missing: false };
  if (embedded && embedded.id === id) return { profile: embedded, missing: false };

  const builtin = getBuiltinColorProfile(id);
  if (builtin) return { profile: builtin, missing: false };

  const stored = getUserColorProfile(id);
  if (stored) return { profile: stored, missing: false };

  return { profile: CLASSIC_COLOR_PROFILE, missing: true };
}
