import { describe, expect, it } from 'vitest';
import { createInitialState } from './defaults';
import { applySettingsToState, chromashiftReducer } from './chromashiftReducer';
import {
  SETTINGS_SCHEMA_VERSION,
  deserializeSettings,
  migrateV1ToV2,
  serializeSettings,
  settingsToJson,
} from './serializeSettings';
import { fromBase64Url, toBase64Url } from './presetUrl';

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

  it('always emits schema version 2', () => {
    const doc = serializeSettings(createInitialState());
    expect(doc.version).toBe(SETTINGS_SCHEMA_VERSION);
    expect(doc.version).toBe(2);
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
    expect(doc?.version).toBe(2);
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

  it('migrates v1 documents to normalized v2', () => {
    const v1 = {
      version: 1,
      settings: {
        layers: { opacity: 0.66 },
        output: { viewportQuarterZoom: true, stampBoost: 2 },
        reactive: { audioSensitivity: 0.8, midiBindings: [] },
      },
    };
    const migrated = migrateV1ToV2(v1);
    expect(migrated.version).toBe(2);
    expect(migrated.settings.layers?.opacity).toBe(0.66);
    expect(migrated.settings.output?.stampBoost).toBe(2);
    expect(migrated.settings.output?.viewportQuarterZoom).toBeUndefined();
    expect(migrated.settings.viewport?.quarterZoom).toBe(true);
    expect(migrated.settings.reactive?.enabled).toBe(false);
    expect(migrated.settings.reactive?.audioSensitivity).toBe(0.8);
    expect(migrated.settings.compare?.layout).toBe('single');
    expect(migrated.settings.kiosk?.kioskEnabled).toBe(false);

    const doc = deserializeSettings(JSON.stringify(v1));
    expect(doc?.version).toBe(2);
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
    expect(doc?.version).toBe(2);
    expect(doc?.settings.layers?.angles).toEqual([12, 34, 56]);
  });
});
