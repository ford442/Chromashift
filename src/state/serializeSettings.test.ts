import { describe, expect, it } from 'vitest';
import { createInitialState } from './defaults';
import { applySettingsToState, chromashiftReducer } from './chromashiftReducer';
import {
  SETTINGS_SCHEMA_VERSION,
  deserializeSettings,
  migrateToLatest,
  serializeSettings,
  settingsToJson,
} from './serializeSettings';
import { fromBase64Url, toBase64Url } from './presetUrl';
import type { ColorProfile } from '../engine/color/colorProfile';

describe('serializeSettings', () => {
  it('round-trips render settings through JSON', () => {
    const state = createInitialState();
    const mutated = chromashiftReducer(state, {
      type: 'layers/patch',
      patch: { opacity: 0.5, angles: [10, 20, 30] },
    });
    const json = settingsToJson(mutated);
    const doc = deserializeSettings(json);
    expect(doc?.settings.layers?.opacity).toBe(0.5);
    expect(doc?.settings.layers?.angles).toEqual([10, 20, 30]);
  });

  it('always emits schema version 3', () => {
    const doc = serializeSettings(createInitialState());
    expect(doc.version).toBe(SETTINGS_SCHEMA_VERSION);
    expect(doc.version).toBe(3);
  });

  it('round-trips v2 field groups', () => {
    let state = createInitialState();
    state = chromashiftReducer(state, {
      type: 'reactive/patch',
      patch: { enabled: true, audioEnabled: true, midiEnabled: true, audioSensitivity: 1.5 },
    });
    state = chromashiftReducer(state, {
      type: 'output/patch',
      patch: {
        viewportQuarterZoom: true,
        viewportHalfOverlay: true,
        performanceHudEnabled: true,
        performanceAutoDegrade: true,
      },
    });
    state = chromashiftReducer(state, { type: 'compare/setLayout', layout: 'dual' });
    state = chromashiftReducer(state, {
      type: 'compare/setSlotB',
      label: 'Neon',
      settings: { tracers: { mode: 2 } },
    });
    state = chromashiftReducer(state, {
      type: 'ui/patch',
      patch: {
        kioskEnabled: true,
        kioskUiHidden: false,
        kioskAttractMode: true,
      },
    });

    const doc = deserializeSettings(settingsToJson(state));
    expect(doc?.version).toBe(3);
    expect(doc?.settings.reactive?.enabled).toBe(true);
    expect(doc?.settings.reactive?.audioEnabled).toBe(true);
    expect(doc?.settings.reactive?.midiEnabled).toBe(true);
    expect(doc?.settings.reactive?.audioSensitivity).toBe(1.5);
    expect(doc?.settings.viewport?.quarterZoom).toBe(true);
    expect(doc?.settings.viewport?.halfOverlay).toBe(true);
    expect(doc?.settings.output?.performanceHudEnabled).toBe(true);
    expect(doc?.settings.output?.performanceAutoDegrade).toBe(true);
    expect(doc?.settings.kiosk?.kioskEnabled).toBe(true);
    expect(doc?.settings.kiosk?.kioskAttractMode).toBe(true);
    expect(doc?.settings.compare?.layout).toBe('dual');
    expect(doc?.settings.compare?.slotB.label).toBe('Neon');
    expect(doc?.settings.compare?.slotB.settings.tracers?.mode).toBe(2);
    expect(doc?.settings.output?.viewportQuarterZoom).toBeUndefined();
    expect(doc?.settings.output?.viewportHalfOverlay).toBeUndefined();

    const restored = applySettingsToState(createInitialState(), doc!.settings);
    expect(restored.reactive.enabled).toBe(true);
    expect(restored.output.viewportQuarterZoom).toBe(true);
    expect(restored.output.performanceHudEnabled).toBe(true);
    expect(restored.ui.compareView.layout).toBe('dual');
    expect(restored.ui.compareView.slotB.settings.tracers?.mode).toBe(2);
  });

  it('round-trips swipe layout and swipePosition', () => {
    let state = createInitialState();
    state = chromashiftReducer(state, { type: 'compare/setLayout', layout: 'swipe' });
    state = chromashiftReducer(state, { type: 'compare/setSwipePosition', swipePosition: 0.3 });

    const doc = deserializeSettings(settingsToJson(state));
    expect(doc?.settings.compare?.layout).toBe('swipe');
    expect(doc?.settings.compare?.swipePosition).toBe(0.3);

    const restored = applySettingsToState(createInitialState(), doc!.settings);
    expect(restored.ui.compareView.layout).toBe('swipe');
    expect(restored.ui.compareView.swipePosition).toBe(0.3);
  });

  it('round-trips quad layout and quadLayerIndex', () => {
    let state = createInitialState();
    state = chromashiftReducer(state, { type: 'compare/setLayout', layout: 'quad' });
    state = chromashiftReducer(state, { type: 'compare/cycleQuadLayer' });

    const doc = deserializeSettings(settingsToJson(state));
    expect(doc?.settings.compare?.layout).toBe('quad');
    expect(doc?.settings.compare?.quadLayerIndex).toBe(1);

    const restored = applySettingsToState(createInitialState(), doc!.settings);
    expect(restored.ui.compareView.layout).toBe('quad');
    expect(restored.ui.compareView.quadLayerIndex).toBe(1);
  });

  it('migrates v1 documents to normalized v3', () => {
    const v1 = {
      version: 1,
      settings: {
        layers: { opacity: 0.66 },
        output: { viewportQuarterZoom: true, stampBoost: 2 },
        reactive: { audioSensitivity: 0.8, midiBindings: [] },
      },
    };
    const migrated = migrateToLatest(v1);
    expect(migrated.version).toBe(3);
    expect(migrated.settings.layers?.opacity).toBe(0.66);
    expect(migrated.settings.output?.stampBoost).toBe(2);
    expect(migrated.settings.output?.viewportQuarterZoom).toBeUndefined();
    expect(migrated.settings.viewport?.quarterZoom).toBe(true);
    expect(migrated.settings.reactive?.enabled).toBe(false);
    expect(migrated.settings.reactive?.audioSensitivity).toBe(0.8);
    expect(migrated.settings.compare?.layout).toBe('single');
    expect(migrated.settings.kiosk?.kioskEnabled).toBe(false);

    const doc = deserializeSettings(JSON.stringify(v1));
    expect(doc?.version).toBe(3);
    // v1/v2 documents predate profiles — they migrate to the classic look.
    expect(doc?.settings.layers?.colorProfileId).toBe('cr0p-classic');
    expect(doc?.settings.layers?.colorProfile).toBeNull();
  });

  it('rejects invalid JSON payloads', () => {
    expect(deserializeSettings('not json')).toBeNull();
    expect(deserializeSettings('{"version":99}')).toBeNull();
    expect(deserializeSettings('{"version":1}')).toBeNull();
  });

  it('accepts v1 share URLs via deserializeSettings', () => {
    const v1 = {
      version: 1,
      settings: {
        layers: { angles: [12, 34, 56], opacity: 0.66 },
        tracers: { aboveIntensity: 0.42 },
      },
    };
    const param = toBase64Url(JSON.stringify(v1));
    const doc = deserializeSettings(fromBase64Url(param));
    expect(doc?.version).toBe(3);
    expect(doc?.settings.layers?.angles).toEqual([12, 34, 56]);
  });

  describe('schema v3 colour profiles', () => {
    const customProfile: ColorProfile = {
      id: 'artist-neon',
      name: 'Artist Neon',
      version: 1,
      preprocess: { diffScale: 0, lightDarkMode: 'raw' as const },
      layers: [
        { name: 'warm', bands: [{ name: 'hot', min: 190, max: 255, rgb: [255, 0, 128] }] },
        { name: 'cool', bands: [{ name: 'cold', min: 158, max: 190, rgb: [0, 255, 255] }] },
        { name: 'leaf', bands: [{ name: 'leaf', min: 125, max: 158, rgb: [128, 255, 0] }] },
      ],
    };

    function stateWithProfile() {
      return chromashiftReducer(createInitialState(), {
        type: 'layers/patch',
        patch: { colorProfileId: 'artist-neon', colorProfile: customProfile },
      });
    }

    it('embeds a custom profile in file exports and round-trips it', () => {
      const doc = deserializeSettings(settingsToJson(stateWithProfile()));
      expect(doc?.settings.layers?.colorProfileId).toBe('artist-neon');
      expect(doc?.settings.layers?.colorProfile?.layers[0].bands[0].rgb).toEqual([255, 0, 128]);

      const restored = applySettingsToState(createInitialState(), doc!.settings);
      expect(restored.layers.colorProfile?.id).toBe('artist-neon');
    });

    it('keeps the id but drops the table when embedding is off (share URLs)', () => {
      const doc = serializeSettings(stateWithProfile(), { embedColorProfile: false });
      expect(doc.settings.layers?.colorProfileId).toBe('artist-neon');
      expect(doc.settings.layers?.colorProfile).toBeNull();
    });

    it('never embeds a table for the classic profile', () => {
      const doc = serializeSettings(createInitialState());
      expect(doc.settings.layers?.colorProfileId).toBe('cr0p-classic');
      expect(doc.settings.layers?.colorProfile).toBeNull();
    });

    it('discards an invalid or mismatched embedded profile', () => {
      const broken = {
        version: 3,
        settings: { layers: { colorProfileId: 'artist-neon', colorProfile: { id: 'artist-neon', layers: [] } } },
      };
      expect(deserializeSettings(JSON.stringify(broken))?.settings.layers?.colorProfile).toBeNull();

      const mismatched = {
        version: 3,
        settings: { layers: { colorProfileId: 'someone-else', colorProfile: customProfile } },
      };
      const doc = deserializeSettings(JSON.stringify(mismatched));
      expect(doc?.settings.layers?.colorProfileId).toBe('someone-else');
      expect(doc?.settings.layers?.colorProfile).toBeNull();
    });
  });
});
