import { describe, expect, it } from 'vitest';
import type { OverlayProps } from './types';
import {
  PANEL_PROP_KEYS,
  selectDiagnosticsPanelProps,
  selectExportPanelProps,
  selectLayerPanelProps,
  selectPlayPanelProps,
  selectPresetsPanelProps,
  selectReactivePanelProps,
  selectRendererPanelProps,
  selectTracerPanelProps,
  selectUpscalePanelProps,
  selectViewportPanelProps,
} from './panelProps';

type Selector = (p: OverlayProps) => object;

const SELECTORS: Record<keyof typeof PANEL_PROP_KEYS, Selector> = {
  play: selectPlayPanelProps,
  renderer: selectRendererPanelProps,
  layer: selectLayerPanelProps,
  tracer: selectTracerPanelProps,
  diagnostics: selectDiagnosticsPanelProps,
  upscale: selectUpscalePanelProps,
  export: selectExportPanelProps,
  viewport: selectViewportPanelProps,
  presets: selectPresetsPanelProps,
  reactive: selectReactivePanelProps,
};

const PANEL_IDS = Object.keys(SELECTORS) as (keyof typeof PANEL_PROP_KEYS)[];

const ALL_KEYS: string[] = [
  ...new Set(PANEL_IDS.flatMap((id) => PANEL_PROP_KEYS[id] as readonly string[])),
];

/**
 * A stand-in `OverlayProps` whose every field is a distinct sentinel object, so
 * a shallow comparison of two slices tells us exactly which keys moved. Only
 * identity matters here, so the values need not match the real prop types.
 */
const BAG = Object.fromEntries(ALL_KEYS.map((key) => [key, { key }])) as unknown as OverlayProps;

/** `BAG` with exactly one key swapped for a fresh sentinel. */
function bagWith(changedKey: string): OverlayProps {
  return { ...BAG, [changedKey]: { key: `${changedKey}:changed` } };
}

function shallowEqual(left: object, right: object): boolean {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => Object.is(a[key], b[key]));
}

describe('overlay panel prop slices', () => {
  it('gives each panel exactly the keys its props interface declares', () => {
    for (const id of PANEL_IDS) {
      const slice = SELECTORS[id](BAG);
      expect(Object.keys(slice).sort()).toEqual([...PANEL_PROP_KEYS[id]].sort());
    }
  });

  it('reads only keys that exist on the overlay prop bag', () => {
    const bag = BAG;
    for (const id of PANEL_IDS) {
      const slice = SELECTORS[id](bag);
      for (const [key, value] of Object.entries(slice as Record<string, unknown>)) {
        expect(value, `${id}.${key} is missing from OverlayProps`).toBeDefined();
      }
    }
  });

  it('leaves a panel slice shallow-equal when an unrelated field changes', () => {
    // This is the property the panels' `memo()` wrappers depend on: touching a
    // tracer control must not hand `PresetsPanel` a different props object.
    for (const id of PANEL_IDS) {
      const owned = new Set<string>(PANEL_PROP_KEYS[id] as readonly string[]);
      const baseline = SELECTORS[id](BAG);

      for (const foreignKey of ALL_KEYS) {
        if (owned.has(foreignKey)) continue;
        expect(
          shallowEqual(baseline, SELECTORS[id](bagWith(foreignKey))),
          `${id} slice changed when unrelated key "${foreignKey}" changed`,
        ).toBe(true);
      }
    }
  });

  it('changes a panel slice when a field that panel owns changes', () => {
    for (const id of PANEL_IDS) {
      const baseline = SELECTORS[id](BAG);
      for (const ownKey of PANEL_PROP_KEYS[id] as readonly string[]) {
        expect(
          shallowEqual(baseline, SELECTORS[id](bagWith(ownKey))),
          `${id} slice ignored its own key "${ownKey}"`,
        ).toBe(false);
      }
    }
  });

  it('covers every key of the overlay prop bag across the panels', () => {
    // A key that no panel reads is dead weight in `buildOverlayProps`.
    const read = new Set(PANEL_IDS.flatMap((id) => PANEL_PROP_KEYS[id] as readonly string[]));
    expect([...read].sort()).toEqual([...ALL_KEYS].sort());
  });
});
