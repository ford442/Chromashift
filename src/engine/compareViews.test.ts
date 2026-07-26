import { describe, expect, it } from 'vitest';
import {
  activeViewCount,
  advanceAngles,
  effectiveLayerScaleForMultiView,
  isQuadCompareLayout,
  isTwoSlotCompareLayout,
  multiViewPerformanceNote,
  nextQuadLayerIndex,
  quadLayerMainViewMode,
} from './compareViews';
import { MAIN_VIEW_MODES } from './viewModes';

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

  it('reduces layer scale in swipe mode', () => {
    const { scale, reduced } = effectiveLayerScaleForMultiView(1, 'swipe');
    expect(scale).toBe(0.85);
    expect(reduced).toBe(true);
  });

  it('identifies two-slot compare layouts', () => {
    expect(isTwoSlotCompareLayout('single')).toBe(false);
    expect(isTwoSlotCompareLayout('dual')).toBe(true);
    expect(isTwoSlotCompareLayout('swipe')).toBe(true);
    expect(isTwoSlotCompareLayout('quad')).toBe(false);
  });

  it('identifies quad layout', () => {
    expect(isQuadCompareLayout('quad')).toBe(true);
    expect(isQuadCompareLayout('dual')).toBe(false);
  });

  it('maps quad layer index to main view modes', () => {
    expect(quadLayerMainViewMode(0)).toBe(MAIN_VIEW_MODES.LAYER_0);
    expect(quadLayerMainViewMode(1)).toBe(MAIN_VIEW_MODES.LAYER_1);
    expect(quadLayerMainViewMode(2)).toBe(MAIN_VIEW_MODES.LAYER_2);
    expect(nextQuadLayerIndex(0)).toBe(1);
    expect(nextQuadLayerIndex(2)).toBe(0);
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
