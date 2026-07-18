import { describe, expect, it } from 'vitest';
import { chromashiftReducer } from './chromashiftReducer';
import { createInitialState } from './defaults';
import { BUILTIN_PRESETS } from './presetGallery';
import {
  PRESET_URL_PARAM,
  buildPresetUrl,
  createInitialStateFromUrl,
  decodeSettingsParam,
  encodeSettingsParam,
  fromBase64Url,
  toBase64Url,
} from './presetUrl';

function mutatedState() {
  let state = createInitialState();
  state = chromashiftReducer(state, {
    type: 'layers/patch',
    patch: { angles: [12, 34, 56], extensions: [111, 222, 333], colorMode: 0, opacity: 0.66 },
  });
  state = chromashiftReducer(state, {
    type: 'tracers/patch',
    patch: { aboveIntensity: 0.42, belowDuration: 3500, layerBlendMode: 4, tracerBlendMode: 7 },
  });
  state = chromashiftReducer(state, {
    type: 'output/patch',
    patch: { outputMode: 1, stampBoost: 2.5, diagnosticsMode: true },
  });
  return state;
}

describe('base64url codec', () => {
  it('round-trips arbitrary UTF-8 text', () => {
    const samples = ['hello', '{"a":1}', 'ünïçødé ✨ 日本語', ''];
    for (const text of samples) {
      expect(fromBase64Url(toBase64Url(text))).toBe(text);
    }
  });

  it('produces URL-safe output', () => {
    const encoded = toBase64Url(JSON.stringify({ x: '???>>>~~~' }));
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('preset URL round-trip', () => {
  it('save → reload URL → identical layer rates, tracers, and modes', () => {
    const original = mutatedState();
    const url = buildPresetUrl(original, 'https://example.com/app');
    const search = new URL(url).search;

    const restored = createInitialStateFromUrl(search);

    expect(restored.layers.angles).toEqual(original.layers.angles);
    expect(restored.layers.extensions).toEqual(original.layers.extensions);
    expect(restored.layers.colorMode).toBe(original.layers.colorMode);
    expect(restored.layers.opacity).toBe(original.layers.opacity);
    expect(restored.tracers).toEqual(original.tracers);
    expect(restored.output.outputMode).toBe(original.output.outputMode);
    expect(restored.output.stampBoost).toBe(original.output.stampBoost);
    expect(restored.output.diagnosticsMode).toBe(original.output.diagnosticsMode);
    expect(restored.ui.presetLoadError).toBeNull();
  });

  it('encodes a versioned document', () => {
    const doc = decodeSettingsParam(encodeSettingsParam(mutatedState()));
    expect(doc?.version).toBe(2);
  });

  it('round-trips v2 compare, reactive, and viewport fields through URL', () => {
    let original = mutatedState();
    original = chromashiftReducer(original, {
      type: 'reactive/patch',
      patch: { enabled: true, audioEnabled: true, midiEnabled: false },
    });
    original = chromashiftReducer(original, {
      type: 'output/patch',
      patch: { viewportQuarterZoom: true, performanceHudEnabled: true },
    });
    original = chromashiftReducer(original, { type: 'compare/setLayout', layout: 'dual' });
    original = chromashiftReducer(original, {
      type: 'compare/setSlotB',
      label: 'Alt',
      settings: { layers: { colorMode: 2 } },
    });

    const restored = createInitialStateFromUrl(
      new URL(buildPresetUrl(original, 'https://example.com/')).search,
    );

    expect(restored.reactive.enabled).toBe(true);
    expect(restored.reactive.audioEnabled).toBe(true);
    expect(restored.output.viewportQuarterZoom).toBe(true);
    expect(restored.output.performanceHudEnabled).toBe(true);
    expect(restored.ui.compareView.layout).toBe('dual');
    expect(restored.ui.compareView.slotB.label).toBe('Alt');
    expect(restored.ui.compareView.slotB.settings.layers?.colorMode).toBe(2);
  });

  it('still accepts v1 preset URLs', () => {
    const v1 = {
      version: 1,
      settings: {
        layers: { angles: [12, 34, 56], opacity: 0.66 },
        tracers: { aboveIntensity: 0.42, belowDuration: 3500 },
        output: { outputMode: 1, stampBoost: 2.5, diagnosticsMode: true },
      },
    };
    const search = `?${PRESET_URL_PARAM}=${toBase64Url(JSON.stringify(v1))}`;
    const restored = createInitialStateFromUrl(search);

    expect(restored.layers.angles).toEqual([12, 34, 56]);
    expect(restored.layers.opacity).toBe(0.66);
    expect(restored.tracers.aboveIntensity).toBe(0.42);
    expect(restored.output.outputMode).toBe(1);
    expect(restored.ui.presetLoadError).toBeNull();
  });

  it('lets ?kiosk=1 override preset kiosk flags', () => {
    let state = createInitialState();
    state = chromashiftReducer(state, {
      type: 'ui/patch',
      patch: { kioskEnabled: true, kioskUiHidden: false, kioskAttractMode: false },
    });
    const presetParam = encodeSettingsParam(state);
    const restored = createInitialStateFromUrl(`?${PRESET_URL_PARAM}=${presetParam}&kiosk=1`);

    expect(restored.ui.kioskEnabled).toBe(true);
    expect(restored.ui.kioskUiHidden).toBe(true);
    expect(restored.ui.kioskAttractMode).toBe(true);
    expect(restored.ui.isAutoPlayActive).toBe(true);
    expect(restored.engine.paused).toBe(false);
    expect(restored.output.livePreviewEnabled).toBe(false);
  });

  it('falls back to defaults with a friendly error on an invalid preset', () => {
    const defaults = createInitialState();
    for (const search of [
      `?${PRESET_URL_PARAM}=%%%not-base64%%%`,
      `?${PRESET_URL_PARAM}=${toBase64Url('not json')}`,
      `?${PRESET_URL_PARAM}=${toBase64Url('{"version":99,"settings":{}}')}`,
    ]) {
      const state = createInitialStateFromUrl(search);
      expect(state.ui.presetLoadError).toMatch(/preset/i);
      expect(state.layers).toEqual(defaults.layers);
      expect(state.tracers).toEqual(defaults.tracers);
    }
  });

  it('ignores an absent preset parameter', () => {
    const state = createInitialStateFromUrl('?renderer=webgl');
    expect(state.ui.presetLoadError).toBeNull();
  });
});

describe('built-in preset gallery', () => {
  it('every gallery preset applies cleanly through the reducer', () => {
    for (const preset of BUILTIN_PRESETS) {
      const state = chromashiftReducer(createInitialState(), {
        type: 'settings/apply',
        settings: preset.settings,
      });
      // Applied fields land where the preset says they should.
      for (const [key, value] of Object.entries(preset.settings.layers ?? {})) {
        expect(state.layers[key as keyof typeof state.layers], `${preset.id}.layers.${key}`).toEqual(value);
      }
      for (const [key, value] of Object.entries(preset.settings.tracers ?? {})) {
        expect(state.tracers[key as keyof typeof state.tracers], `${preset.id}.tracers.${key}`).toEqual(value);
      }
    }
  });

  it('gallery presets survive a URL round-trip', () => {
    for (const preset of BUILTIN_PRESETS) {
      const applied = chromashiftReducer(createInitialState(), {
        type: 'settings/apply',
        settings: preset.settings,
      });
      const search = new URL(buildPresetUrl(applied, 'https://example.com/')).search;
      const restored = createInitialStateFromUrl(search);
      expect(restored.layers).toEqual(applied.layers);
      expect(restored.tracers).toEqual(applied.tracers);
      expect(restored.output).toEqual(applied.output);
    }
  });

  it('applies kiosk bootstrap from ?kiosk=1', () => {
    const state = createInitialStateFromUrl('?kiosk=1');
    expect(state.ui.kioskEnabled).toBe(true);
    expect(state.ui.kioskUiHidden).toBe(true);
    expect(state.ui.kioskAttractMode).toBe(true);
    expect(state.ui.isAutoPlayActive).toBe(true);
    expect(state.engine.paused).toBe(false);
    expect(state.output.livePreviewEnabled).toBe(false);
  });
});
