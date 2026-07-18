import { describe, expect, it } from 'vitest';
import { durationToDecayWith } from '../WasmEngine';
import { durationToDecay } from './decay';

describe('durationToDecay', () => {
  it('matches pow(0.1, 1/frames) for typical tracer settings', () => {
    const fps = 30;
    const durationMs = 500;
    const frames = (fps * durationMs) / 1000;
    const expected = Math.pow(0.1, 1 / frames);

    expect(durationToDecay(durationMs, fps)).toBeCloseTo(expected, 6);
  });

  it('reaches ~10% brightness after the configured frame count', () => {
    const fps = 30;
    const durationMs = 500;
    const frames = Math.floor((fps * durationMs) / 1000);
    const decay = durationToDecay(durationMs, fps);

    let brightness = 1;
    for (let i = 0; i < frames; i++) {
      brightness *= decay;
    }
    expect(brightness).toBeCloseTo(0.1, 4);
  });

  it('returns 0 when duration is zero or negative', () => {
    expect(durationToDecay(0, 30)).toBe(0);
    expect(durationToDecay(-100, 30)).toBe(0);
  });

  it('returns 0 when fewer than one frame elapses', () => {
    expect(durationToDecay(10, 30)).toBe(0);
    expect(durationToDecay(500, 0)).toBe(0);
  });
});

describe('durationToDecayWith (TS fallback)', () => {
  it('matches durationToDecay when useWasm is false', () => {
    const cases: Array<[number, number]> = [
      [500, 30],
      [2000, 60],
      [0, 30],
      [-100, 30],
      [10, 30],
      [500, 0],
    ];
    for (const [durationMs, fps] of cases) {
      expect(durationToDecayWith(durationMs, fps, false)).toBe(durationToDecay(durationMs, fps));
    }
  });

  it('matches pow(0.1, 1/frames) for typical tracer settings', () => {
    const fps = 30;
    const durationMs = 500;
    const frames = (fps * durationMs) / 1000;
    const expected = Math.pow(0.1, 1 / frames);

    expect(durationToDecayWith(durationMs, fps, false)).toBeCloseTo(expected, 6);
  });
});
