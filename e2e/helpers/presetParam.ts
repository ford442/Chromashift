/** Build a ?preset= base64url value matching the app's encodeSettingsParam format. */
export function encodePresetParam(document: unknown): string {
  const json = JSON.stringify(document);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Minimal preset document used by preset-url E2E (mirrors unit-test fixtures). */
export const SAMPLE_PRESET_DOCUMENT = {
  version: 1,
  settings: {
    layers: { angles: [12, 34, 56], colorMode: 0, opacity: 0.66 },
    tracers: { aboveIntensity: 0.42, belowDuration: 3500 },
    output: { outputMode: 1, stampBoost: 2.5 },
  },
} as const;

const COMPARE_SLOT_DEFAULTS = {
  slotA: { id: 'a', label: 'Live', settings: {} },
  swipePosition: 0.5,
  quadLayerIndex: 0,
} as const;

/** v2 dual compare preset for compare-dual / preset-compare E2E. */
export const DUAL_COMPARE_PRESET = {
  version: 2,
  settings: {
    compare: {
      layout: 'dual',
      syncPlay: true,
      ...COMPARE_SLOT_DEFAULTS,
      slotB: {
        id: 'b',
        label: 'Soft Glow',
        settings: {
          layers: { colorMode: 1, softCropEnabled: true, opacity: 0.9 },
          tracers: { aboveIntensity: 0.6, belowIntensity: 0.25 },
        },
      },
    },
  },
} as const;

/** v2 dual preset with Neon slot B label (preset URL hydrate). */
export const DUAL_NEON_PRESET = {
  version: 2,
  settings: {
    compare: {
      layout: 'dual',
      syncPlay: true,
      ...COMPARE_SLOT_DEFAULTS,
      slotB: {
        id: 'b',
        label: 'Neon',
        settings: { tracers: { mode: 2 } },
      },
    },
  },
} as const;

/** v2 dual preset with syncPlay disabled. */
export const DUAL_SYNC_OFF_PRESET = {
  version: 2,
  settings: {
    compare: {
      layout: 'dual',
      syncPlay: false,
      ...COMPARE_SLOT_DEFAULTS,
      slotB: {
        id: 'b',
        label: 'Preset B',
        settings: {},
      },
    },
  },
} as const;

/** v2 viewport quarter-zoom preset for viewport-transforms E2E. */
export const VIEWPORT_QUARTER_ZOOM_PRESET = {
  version: 2,
  settings: {
    viewport: { quarterZoom: true, halfOverlay: false },
  },
} as const;

/** v2 viewport half-overlay preset for viewport-transforms E2E. */
export const VIEWPORT_HALF_OVERLAY_PRESET = {
  version: 2,
  settings: {
    viewport: { quarterZoom: false, halfOverlay: true },
  },
} as const;
