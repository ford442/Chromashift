import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../state/defaults';
import { chromashiftReducer } from '../../state/chromashiftReducer';
import {
  computeAudioModulation,
  extractEnergy,
  extractFrequencyBands,
  midiValueToParam,
} from './modulation';

describe('extractFrequencyBands', () => {
  it('returns higher bass when low bins are energised', () => {
    const mags = new Float32Array(256);
    for (let i = 0; i < 8; i += 1) mags[i] = 200;
    const bands = extractFrequencyBands(mags);
    expect(bands.bass).toBeGreaterThan(bands.high);
    expect(bands.bass).toBeGreaterThan(0.5);
  });
});

describe('extractEnergy', () => {
  it('returns ~0 for silence and higher for full-scale square wave', () => {
    const silent = new Uint8Array(128).fill(128);
    const loud = new Uint8Array(128);
    for (let i = 0; i < loud.length; i += 1) {
      loud[i] = i % 2 === 0 ? 255 : 0;
    }
    expect(extractEnergy(silent)).toBeLessThan(0.05);
    expect(extractEnergy(loud)).toBeGreaterThan(0.5);
  });
});

describe('computeAudioModulation', () => {
  it('modulates at least layer 0 step and tracer above with strong highs', () => {
    const state = createInitialState();
    const baseExt0 = state.layers.extensions[0];
    const baseAbove = state.tracers.aboveIntensity;
    const mod = computeAudioModulation(state, {
      bass: 0,
      mid: 0,
      high: 1,
      energy: 0.8,
    });
    expect(mod.extensions[0]).toBe(baseExt0);
    expect(mod.extensions[1]).toBeGreaterThan(state.layers.extensions[1]);
    expect(mod.tracerAboveIntensity).toBeGreaterThan(baseAbove);
  });
});

describe('computeAudioModulation at any layer count', () => {
  const levels = { bass: 0.5, mid: 0.25, high: 1, energy: 0.8 };

  it.each([1, 2, 5, 10])('returns one finite rate per layer at %i layers', (count) => {
    const state = chromashiftReducer(createInitialState(), { type: 'layers/setCount', count });
    const mod = computeAudioModulation(state, levels);
    expect(mod.extensions).toHaveLength(count);
    for (const ext of mod.extensions) expect(Number.isFinite(ext)).toBe(true);
  });

  it('cycles mid / high / bass past the canonical three', () => {
    const state = chromashiftReducer(createInitialState(), { type: 'layers/setCount', count: 5 });
    const s = state.reactive.audioSensitivity;
    const mod = computeAudioModulation(state, levels);
    const ext = state.layers.extensions;
    const expected = [
      ext[0] * (1 + levels.mid * 0.6 * s),
      ext[1] * (1 + levels.high * 0.6 * s),
      ext[2] * (1 + levels.bass * 0.4 * s),
      ext[3] * (1 + levels.mid * 0.6 * s),
      ext[4] * (1 + levels.high * 0.6 * s),
    ].map((v) => Math.min(Math.max(v, 0), 360));
    expect(mod.extensions).toEqual(expected);
  });
});

describe('midiValueToParam', () => {
  it('maps CC 127 to layer step 360', () => {
    expect(midiValueToParam('layers.extensions.0', 1)).toBe(360);
    expect(midiValueToParam('layers.extensions.0', 0)).toBe(0);
  });
});
