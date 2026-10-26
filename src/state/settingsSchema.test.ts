import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromashiftReducer } from './chromashiftReducer';
import { createInitialState } from './defaults';
import { BUILTIN_PRESETS } from './presetGallery';
import { createInitialStateFromUrl, toBase64Url } from './presetUrl';
import {
  decodeSettingsDocument,
  deserializeSettings,
  serializeSettings,
  settingsToJson,
} from './serializeSettings';
import { numericLeaves } from './schemaFields';
import { settingsSchema } from './settingsSchema';
import type { ChromashiftState } from './types';

afterEach(() => {
  vi.restoreAllMocks();
});

function doc(settings: unknown, version = 8): string {
  return JSON.stringify({ version, settings });
}

/** Where a settings-schema path lives in `ChromashiftState`, or null when it has no session default. */
function statePathFor(schemaPath: string): string | null {
  const parts = schemaPath.split('.');
  const [slice, ...rest] = parts;
  if (slice === 'compare') {
    return rest[0] === 'slotA' || rest[0] === 'slotB' ? null : ['ui', 'compareView', ...rest].join('.');
  }
  if (slice === 'reactive' && rest[0] === 'midiBindings') return null;
  return parts.map((part) => (part === '*' ? '0' : part)).join('.');
}

function readPath(state: ChromashiftState, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (value, key) => (value as Record<string, unknown> | undefined)?.[key],
    state,
  );
}

describe('settings schema', () => {
  it('gives every numeric leaf the session default', () => {
    const state = createInitialState();
    const checked: string[] = [];
    for (const { path, meta } of numericLeaves(settingsSchema)) {
      const statePath = statePathFor(path);
      if (!statePath) continue;
      expect(readPath(state, statePath), path).toBe(meta.default);
      checked.push(path);
    }
    expect(checked).toContain('engine.fps');
    expect(checked).toContain('output.tracerInspect.pan.x');
  });

  it('puts every session default inside its own range', () => {
    for (const { path, meta } of numericLeaves(settingsSchema)) {
      expect(meta.min, path).toBeLessThan(meta.max);
      expect(meta.default, path).toBeGreaterThanOrEqual(meta.min);
      expect(meta.default, path).toBeLessThanOrEqual(meta.max);
      expect(meta.label, path).not.toBe('');
    }
  });

  it('decodes what the serializer writes without a single correction', () => {
    const states: ChromashiftState[] = [createInitialState()];
    let busy = chromashiftReducer(createInitialState(), { type: 'layers/setCount', count: 10 });
    busy = chromashiftReducer(busy, { type: 'compare/setLayout', layout: 'quad' });
    busy = chromashiftReducer(busy, {
      type: 'compare/setSlotB', label: 'Gallery', settings: BUILTIN_PRESETS[1].settings,
    });
    busy = chromashiftReducer(busy, {
      type: 'reactive/addMidiBinding',
      binding: { channel: 3, controller: 74, param: 'tracers.aboveIntensity' },
    });
    states.push(busy);
    for (const preset of BUILTIN_PRESETS) {
      states.push(chromashiftReducer(createInitialState(), { type: 'settings/apply', settings: preset.settings }));
    }

    for (const state of states) {
      for (const embedColorProfile of [true, false]) {
        const json = JSON.stringify(serializeSettings(state, { embedColorProfile, compactLayers: true }));
        expect(decodeSettingsDocument(json).issues).toEqual([]);
      }
      expect(decodeSettingsDocument(settingsToJson(state)).issues).toEqual([]);
    }
  });
});

describe('deserializeSettings at the boundary', () => {
  it('clamps fps, ignores runtime ui state, and warns once (#226 acceptance)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const search = `?preset=${toBase64Url(doc({ engine: { fps: 0 }, ui: { exportingVideo: true } }))}`;
    const state = createInitialStateFromUrl(search);

    expect(state.engine.fps).toBe(1);
    expect(state.ui.exportingVideo).toBe(false);
    expect(state.ui.presetLoadError).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('engine.fps: clamped 0 → 1');
    expect(message).toContain('ui.exportingVideo: unknown field');
  });

  it('cannot set runtime engine state', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const decoded = deserializeSettings(doc({
      engine: { gpuReady: true, backend: 'webgl', fps: 24 },
      output: { tracerPreviewFrozen: true },
    }));
    expect(decoded?.settings.engine).toEqual({ fps: 24 });
    expect(decoded?.settings.output).toEqual({});
  });

  it('keeps every good field when one is bad', () => {
    const { document, issues } = decodeSettingsDocument(doc({
      tracers: { aboveIntensity: 'loud', belowIntensity: 0.4, aboveDuration: 1e9 },
      layers: { opacity: 0.5, sobelEnabled: 'yes' },
    }));
    expect(document?.settings.tracers).toMatchObject({ belowIntensity: 0.4, aboveDuration: 5000 });
    expect(document?.settings.tracers).not.toHaveProperty('aboveIntensity');
    expect(document?.settings.layers).toMatchObject({ opacity: 0.5 });
    expect(document?.settings.layers).not.toHaveProperty('sobelEnabled');
    expect(issues.map((issue) => issue.path)).toEqual([
      'layers.sobelEnabled',
      'tracers.aboveIntensity',
      'tracers.aboveDuration',
    ]);
  });

  it('fills a bad per-layer entry in place rather than shifting the layers after it', () => {
    const { document } = decodeSettingsDocument(doc({
      layers: { count: 3, extensions: [10, 'fast', 30], opacities: [0.5, null, 2] },
    }));
    expect(document?.settings.layers?.extensions).toEqual([10, 230, 30]);
    expect(document?.settings.layers?.opacities).toEqual([0.5, 1, 1]);
  });

  it('wraps angles instead of clamping them', () => {
    const { document, issues } = decodeSettingsDocument(doc({ layers: { angles: [370, -90, 360] } }));
    expect(document?.settings.layers?.angles).toEqual([10, 270, 0]);
    expect(issues).toEqual([]);
  });

  it('rounds integer fields and drops MIDI bindings it cannot use', () => {
    const { document } = decodeSettingsDocument(doc({
      engine: { fps: 29.6 },
      reactive: {
        midiBindings: [
          { channel: 0, controller: 7, param: 'tracers.belowIntensity' },
          { channel: 0, controller: 8, param: 'engine.gpuReady' },
          { channel: 0, param: 'tracers.aboveIntensity' },
          { channel: 99, controller: 200, param: 'tracers.aboveIntensity' },
        ],
      },
    }));
    expect(document?.settings.engine?.fps).toBe(30);
    expect(document?.settings.reactive?.midiBindings).toEqual([
      { channel: 0, controller: 7, param: 'tracers.belowIntensity' },
      { channel: 15, controller: 127, param: 'tracers.aboveIntensity' },
    ]);
  });

  it('loads a partial compare view over the default one', () => {
    const { document } = decodeSettingsDocument(doc({
      compare: { layout: 'dual', slotB: { label: 'B only' } },
    }));
    const compare = document?.settings.compare;
    expect(compare?.layout).toBe('dual');
    expect(compare?.slotB?.label).toBe('B only');
    expect(compare?.slotB?.id).toBe('b');
    expect(compare?.slotA?.label).toBe('Live');
    expect(compare?.swipePosition).toBe(0.5);
  });

  it('treats __proto__ as an unknown key, not a prototype', () => {
    const { document, issues } = decodeSettingsDocument(
      '{"version":8,"settings":{"engine":{"__proto__":{"gpuReady":true},"fps":12}}}',
    );
    expect(document?.settings.engine).toEqual({ fps: 12 });
    expect(Object.getPrototypeOf(document?.settings.engine)).toBe(Object.prototype);
    expect(issues.map((issue) => issue.path)).toEqual(['engine.__proto__']);
  });

  it('still rejects the whole document when the envelope is unusable', () => {
    expect(deserializeSettings('not json')).toBeNull();
    expect(deserializeSettings(JSON.stringify({ version: 99, settings: {} }))).toBeNull();
    expect(deserializeSettings(JSON.stringify({ version: 8, settings: 'x' }))).toBeNull();
    expect(deserializeSettings(JSON.stringify([]))).toBeNull();
  });

  it('does not warn for a clean document', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(deserializeSettings(settingsToJson(createInitialState()))).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
