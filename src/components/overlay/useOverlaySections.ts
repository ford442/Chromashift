import { useCallback, useState } from 'react';
import { OVERLAY_SECTION_STORAGE_KEY } from './constants';
import type { OverlaySectionId } from './types';

const DEFAULT_OPEN: Record<OverlaySectionId, boolean> = {
  renderer: true,
  layers: true,
  tracer: true,
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
    const parsed = JSON.parse(raw) as Partial<Record<OverlaySectionId, boolean>>;
    return { ...DEFAULT_OPEN, ...parsed };
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
