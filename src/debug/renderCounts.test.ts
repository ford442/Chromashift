import { describe, expect, it } from 'vitest';
import { isRenderCountDebugEnabled, renderCounts, useRenderCount } from './renderCounts';

describe('render-count breadcrumb', () => {
  it('stays off unless the debug flag is set', () => {
    // Node test env: no `?debugRenders=1`, no localStorage entry.
    expect(isRenderCountDebugEnabled()).toBe(false);
  });

  it('records nothing and installs no global while disabled', () => {
    useRenderCount('ImageStrip');
    useRenderCount('ImageStrip');
    expect(renderCounts.snapshot()).toEqual({});
    expect((globalThis as { __renderCounts?: unknown }).__renderCounts).toBeUndefined();
  });

  it('zeroes counters without dropping keys on reset', () => {
    // `reset()` keeps the keys so an idle window reads as an explicit zero per
    // component rather than a silently absent entry.
    renderCounts.counts.TracerPanel = 7;
    renderCounts.counts.NunifOverlay = 3;
    renderCounts.reset();
    expect(renderCounts.snapshot()).toEqual({ TracerPanel: 0, NunifOverlay: 0 });
  });

  it('hands out a copy, not the live tally', () => {
    const snapshot = renderCounts.snapshot();
    renderCounts.counts.TracerPanel = 99;
    expect(snapshot.TracerPanel).toBe(0);
    renderCounts.reset();
  });
});
