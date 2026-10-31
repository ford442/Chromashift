import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MAX_LAYER_COUNT } from '../engine/graph';
import { createInitialState } from '../state/defaults';
import { toBase64Url } from '../state/presetUrl';
import { SETTINGS_SCHEMA_VERSION } from '../state/serializeSettings';
import { loadSettings } from './settings';

const CR0P = readFileSync(new URL('../../examples/cr0p.json', import.meta.url), 'utf8');

describe('loadSettings', () => {
  it('is the session defaults without an argument', () => {
    expect(loadSettings()).toEqual({ state: createInitialState(), corrections: [] });
    expect(loadSettings('  ')).toEqual({ state: createInitialState(), corrections: [] });
  });

  it('applies a settings document', () => {
    const { state, corrections } = loadSettings(CR0P);
    expect(corrections).toEqual([]);
    expect(state).not.toEqual(createInitialState());
  });

  it('reads the same settings from every form of a ?preset= share', () => {
    const fromDocument = loadSettings(CR0P).state;
    const param = toBase64Url(CR0P);
    for (const share of [param, `preset=${param}`, `?preset=${param}`, `https://example.test/app/?kiosk=1&preset=${param}`]) {
      expect(loadSettings(share).state).toEqual(fromDocument);
    }
  });

  it('reports what the decoder corrected', () => {
    const { state, corrections } = loadSettings(
      JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, settings: { layers: { count: 99 } } }),
    );
    expect(state.layers.count).toBe(MAX_LAYER_COUNT);
    expect(corrections).toEqual([`layers.count: clamped 99 → ${MAX_LAYER_COUNT} (range 1–${MAX_LAYER_COUNT})`]);
  });

  it('refuses text that is neither', () => {
    expect(() => loadSettings('definitely not settings!')).toThrow(/neither a JSON document nor/);
  });
});
