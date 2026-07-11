import { describe, expect, it } from 'vitest';
import { createInitialState } from '../../state/defaults';
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

describe('midiValueToParam', () => {
  it('maps CC 127 to layer step 360', () => {
    expect(midiValueToParam('layers.extensions.0', 1)).toBe(360);
    expect(midiValueToParam('layers.extensions.0', 0)).toBe(0);
  });
});
