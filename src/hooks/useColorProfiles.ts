import { useCallback, useMemo, useState } from 'react';
import {
  BUILTIN_COLOR_PROFILES,
  CLASSIC_PROFILE_ID,
  type ColorProfile,
} from '../engine/color/colorProfile';
import {
  colorProfileToJson,
  deleteUserColorProfile,
  importColorProfileJson,
  listUserColorProfiles,
  resolveColorProfile,
} from '../engine/color/colorProfileLibrary';
import type { ChromashiftStore } from './useChromashiftStore';

export interface ColorProfileControls {
  builtinProfiles: readonly ColorProfile[];
  userProfiles: ColorProfile[];
  activeProfileId: string;
  /** Set when the saved id could not be resolved and Classic was substituted. */
  profileError: string | null;
  profileStatus: string | null;
  onSelectProfile: (id: string) => void;
  onImportProfileFile: (file: File) => Promise<void>;
  onExportActiveProfile: () => void;
  onDeleteProfile: (id: string) => void;
}

/**
 * Colour-profile selection, import/export and the local profile library
 * (see docs/COLOR_PROFILES.md). Mirrors `usePresets`' shape.
 */
export function useColorProfiles(store: ChromashiftStore): { colorProfiles: ColorProfileControls } {
  const { state, actions } = store;
  const [userProfiles, setUserProfiles] = useState<ColorProfile[]>(() => listUserColorProfiles());
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const activeProfileId = state.layers.colorProfileId;
  const embedded = state.layers.colorProfile;

  const resolved = useMemo(
    () => resolveColorProfile(activeProfileId, embedded),
    [activeProfileId, embedded],
  );

  const onSelectProfile = useCallback((id: string) => {
    const { profile, missing } = resolveColorProfile(id, null);
    if (missing) {
      setImportError(`Colour profile “${id}” is not available — Classic is still active.`);
      return;
    }
    // Built-ins resolve everywhere; user profiles ride along in the preset file.
    actions.setColorProfile(profile.id, profile.builtin ? null : profile);
    setImportError(null);
    setProfileStatus(`Profile: ${profile.name}`);
  }, [actions]);

  const onImportProfileFile = useCallback(async (file: File) => {
    const { profile, error } = importColorProfileJson(await file.text());
    if (!profile) {
      setImportError(`“${file.name}” is not a valid colour profile — ${error}`);
      return;
    }
    setUserProfiles(listUserColorProfiles());
    actions.setColorProfile(profile.id, profile);
    setImportError(null);
    setProfileStatus(`Imported “${profile.name}”`);
  }, [actions]);

  const onExportActiveProfile = useCallback(() => {
    const blob = new Blob([colorProfileToJson(resolved.profile)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = `${resolved.profile.id}.json`;
    link.click();
    URL.revokeObjectURL(href);
    setProfileStatus(`Exported “${resolved.profile.name}”`);
  }, [resolved]);

  const onDeleteProfile = useCallback((id: string) => {
    setUserProfiles(deleteUserColorProfile(id));
    if (id === activeProfileId) actions.setColorProfile(CLASSIC_PROFILE_ID, null);
    setProfileStatus(`Deleted “${id}”`);
  }, [actions, activeProfileId]);

  const profileError = importError
    ?? (resolved.missing
      ? `Colour profile “${activeProfileId}” was not found — showing Classic.`
      : null);

  return {
    colorProfiles: {
      builtinProfiles: BUILTIN_COLOR_PROFILES,
      userProfiles,
      activeProfileId: resolved.missing ? CLASSIC_PROFILE_ID : activeProfileId,
      profileError,
      profileStatus,
      onSelectProfile,
      onImportProfileFile,
      onExportActiveProfile,
      onDeleteProfile,
    },
  };
}
