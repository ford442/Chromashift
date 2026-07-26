import { describe, expect, it } from 'vitest';
import {
  activeViewCount,
  advanceAngles,
  effectiveLayerScaleForMultiView,
  multiViewPerformanceNote,
} from './compareViews';

describe('compareViews budget helpers', () => {
  it('counts active views per layout', () => {
    expect(activeViewCount('single')).toBe(1);
    expect(activeViewCount('dual')).toBe(2);
    expect(activeViewCount('quad')).toBe(4);
    expect(activeViewCount('swipe')).toBe(2);
  });

  it('reduces layer scale in dual mode', () => {
    const { scale, reduced } = effectiveLayerScaleForMultiView(1, 'dual');
    expect(scale).toBe(0.75);
    expect(reduced).toBe(true);
  });

  it('does not mark single view as reduced', () => {
    const { scale, reduced } = effectiveLayerScaleForMultiView(1, 'single');
    expect(scale).toBe(1);
    expect(reduced).toBe(false);
  });

  it('floors scale at 0.25', () => {
    const { scale } = effectiveLayerScaleForMultiView(0.3, 'quad');
    expect(scale).toBe(0.25);
  });

  it('floors dual scale at 0.25 and marks it reduced', () => {
    const { scale, reduced } = effectiveLayerScaleForMultiView(0.3, 'dual');
    expect(scale).toBe(0.25);
    expect(reduced).toBe(true);
  });

  it('advances angles by extensions with wraparound at 360', () => {
    expect(advanceAngles([0, 100, 350], [10, 20, 30])).toEqual([10, 120, 20]);
    const prev: [number, number, number] = [5, 5, 5];
    expect(advanceAngles(prev, [0, 0, 0])).toEqual([5, 5, 5]);
    expect(prev).toEqual([5, 5, 5]);
  });

  it('scales extension steps so wall-clock spin is FPS-independent', () => {
    // At reference 30 FPS, one frame advances by the stored step.
    expect(advanceAngles([0, 0, 0], [130, 230, 330], 30)).toEqual([130, 230, 330]);
    // At 60 FPS, each frame advances half as far — two frames match one 30 FPS frame.
    const half = advanceAngles([0, 0, 0], [130, 230, 330], 60);
    expect(half[0]).toBeCloseTo(65);
    expect(half[1]).toBeCloseTo(115);
    expect(half[2]).toBeCloseTo(165);
    const full = advanceAngles(half, [130, 230, 330], 60);
    expect(full[0]).toBeCloseTo(130);
    expect(full[1]).toBeCloseTo(230);
    expect(full[2]).toBeCloseTo(330);
  });

  it('returns a performance note for multi-view layouts', () => {
    expect(multiViewPerformanceNote('single')).toBeNull();
    expect(multiViewPerformanceNote('dual')).toContain('2× GPU');
    expect(multiViewPerformanceNote('quad')).toContain('layer scale');
  });
});
