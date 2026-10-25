import { useCallback, useState } from 'react';
import { OVERLAY_SECTION_STORAGE_KEY } from './constants';
import type { OverlaySectionId } from './types';

const DEFAULT_OPEN: Record<OverlaySectionId, boolean> = {
  renderer: true,
  layers: true,
  tracer: true,
  reactive: false,
  upscale: false,
  diagnostics: false,
  export: true,
  viewport: false,
  presets: false,
};

function readStoredSections(): Record<OverlaySectionId, boolean> {
  try {
    const raw = localStorage.getItem(OVERLAY_SECTION_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_OPEN };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_OPEN };
    // Only known ids with boolean values — a stale or hand-edited entry can't
    // add sections or make one truthy with a string.
    const stored = parsed as Record<string, unknown>;
    const sections = { ...DEFAULT_OPEN };
    for (const id of Object.keys(DEFAULT_OPEN) as OverlaySectionId[]) {
      if (typeof stored[id] === 'boolean') sections[id] = stored[id];
    }
    return sections;
  } catch {
    return { ...DEFAULT_OPEN };
  }
}

export function useOverlaySections() {
  const [sections, setSections] = useState(readStoredSections);

  const toggleSection = useCallback((id: OverlaySectionId) => {
    setSections((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(OVERLAY_SECTION_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore quota / private mode
      }
      return next;
    });
  }, []);

  return { sections, toggleSection };
}
