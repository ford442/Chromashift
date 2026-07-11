import { describe, expect, it } from 'vitest';
import {
  activeViewCount,
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

  it('returns a performance note for multi-view layouts', () => {
    expect(multiViewPerformanceNote('single')).toBeNull();
    expect(multiViewPerformanceNote('dual')).toContain('2× GPU');
    expect(multiViewPerformanceNote('quad')).toContain('layer scale');
  });
});
