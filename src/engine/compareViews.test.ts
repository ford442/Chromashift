import { describe, expect, it } from 'vitest';
import {
  activeViewCount,
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

  it('returns a performance note for multi-view layouts', () => {
    expect(multiViewPerformanceNote('single')).toBeNull();
    expect(multiViewPerformanceNote('dual')).toContain('2× GPU');
    expect(multiViewPerformanceNote('quad')).toContain('layer scale');
  });
});
