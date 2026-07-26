import type { Page } from '@playwright/test';

const OVERLAY_SECTION_STORAGE_KEY = 'chromashift.overlay.sections';

export type OverlaySectionId =
  | 'renderer'
  | 'layers'
  | 'tracer'
  | 'reactive'
  | 'upscale'
  | 'diagnostics'
  | 'export'
  | 'viewport'
  | 'presets';

/** Open overlay sections before navigation (avoids flaky clicks on collapsed headers). */
export async function primeOverlaySections(
  page: Page,
  open: Partial<Record<OverlaySectionId, boolean>>,
): Promise<void> {
  await page.addInitScript(({ key, sections }) => {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) as Record<string, boolean> : {};
      localStorage.setItem(key, JSON.stringify({ ...parsed, ...sections }));
    } catch {
      // ignore quota / private mode
    }
  }, { key: OVERLAY_SECTION_STORAGE_KEY, sections: open });
}
