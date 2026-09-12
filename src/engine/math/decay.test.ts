import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { durationToDecayWith } from '../WasmEngine';
import {
  DECAY_IDLE_EXPONENT,
  DECAY_OVERLAP_EXPONENT,
  DECAY_RESIDUAL_BRIGHTNESS,
  durationToDecay,
  effectiveDecay,
} from './decay';

/**
 * Per-frame render/persistence/compositor files must compute decay directly and
 * stay off the WASM bridge entirely — no `*With()` dispatcher, no `WasmEngine`
 * import, no reach into `wasm/dispatch`. See issue #145.
 */
const HOT_PATH_FILES = [
  '../PersistencePass.ts',
  '../CompositorPass.ts',
  '../WebGPURenderer.ts',
  '../StationaryPreviewRenderer.ts',
  '../compute/chores/webgpuBackend.ts',
  '../webgl/WebGLRenderer.ts',
  '../webgl/WebGLPersistencePass.ts',
  '../webgl/WebGLCompositorPass.ts',
  '../webgl/WebGLStationaryPreviewRenderer.ts',
  '../../hooks/useAnimationLoop.ts',
];

describe('durationToDecay', () => {
  it('matches pow(0.1, 1/frames) for typical tracer settings', () => {
    const fps = 30;
    const durationMs = 500;
    const frames = (fps * durationMs) / 1000;
    const expected = Math.pow(0.1, 1 / frames);

    expect(durationToDecay(durationMs, fps)).toBeCloseTo(expected, 6);
  });

  it('reaches the canonical residual brightness after the configured frame count', () => {
    const fps = 30;
    const durationMs = 500;
    const frames = Math.floor((fps * durationMs) / 1000);
    const decay = durationToDecay(durationMs, fps);

    let brightness = 1;
    for (let i = 0; i < frames; i++) {
      brightness *= decay;
    }
    expect(brightness).toBeCloseTo(DECAY_RESIDUAL_BRIGHTNESS, 4);
    expect(DECAY_RESIDUAL_BRIGHTNESS).toBe(0.1);
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

describe('effectiveDecay', () => {
  it('applies the decay factor unchanged when no layers overlap', () => {
    const decay = durationToDecay(500, 30);
    expect(effectiveDecay(decay, false)).toBeCloseTo(
      Math.pow(decay, DECAY_IDLE_EXPONENT),
      12,
    );
    expect(effectiveDecay(decay, false)).toBeCloseTo(decay, 12);
  });

  it('raises the decay factor to the overlap exponent where layers overlap', () => {
    const decay = durationToDecay(500, 30);
    expect(effectiveDecay(decay, true)).toBeCloseTo(
      Math.pow(decay, DECAY_OVERLAP_EXPONENT),
      12,
    );
    // Faster fade means a smaller surviving fraction per frame.
    expect(effectiveDecay(decay, true)).toBeLessThan(effectiveDecay(decay, false));
  });

  it('leaves a paused tracer (decay 1) untouched on both branches', () => {
    expect(effectiveDecay(1, true)).toBe(1);
    expect(effectiveDecay(1, false)).toBe(1);
  });

  it('stays at zero for a zero decay factor', () => {
    expect(effectiveDecay(0, true)).toBe(0);
    expect(effectiveDecay(0, false)).toBe(0);
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

describe('per-frame decay does not route through WASM', () => {
  it.each(HOT_PATH_FILES)('%s never imports a WASM dispatcher', (relPath) => {
    const source = readFileSync(join(__dirname, relPath), 'utf-8');
    expect(source).not.toMatch(/durationToDecayWith/);
    // Any `*With()` dispatcher, however it was imported.
    expect(source).not.toMatch(/\b\w+With\(/);
    expect(source).not.toMatch(/from ['"][^'"]*WasmEngine['"]/);
    expect(source).not.toMatch(/from ['"][^'"]*wasm\/(dispatch|loadEngine)/);
  });
});
