import { describe, expect, it } from 'vitest';
import { chromashiftReducer, createInitialState } from './chromashiftReducer';

/**
 * `useReducer` compares the returned state by identity, so a reducer that
 * allocates a new object for a patch that changes nothing re-renders the whole
 * UI tree for free. Several writers re-publish recomputed values (the luminance
 * sampler, image-aspect reporting), which is what kept a merely-running session
 * re-rendering a few times a second.
 */
describe('chromashiftReducer no-op patches', () => {
  const base = createInitialState();

  it('returns the same state when a patch changes nothing', () => {
    const same = chromashiftReducer(base, {
      type: 'engine/patch',
      patch: { avgLuminance: base.engine.avgLuminance },
    });
    expect(same).toBe(base);
    expect(same.engine).toBe(base.engine);
  });

  it('bails out across every patched slice', () => {
    const noops = [
      { type: 'media/patch', patch: { aspect: base.media.aspect } },
      { type: 'layers/patch', patch: { scale: base.layers.scale } },
      { type: 'tracers/patch', patch: { mode: base.tracers.mode } },
      { type: 'output/patch', patch: { stampBoost: base.output.stampBoost } },
      { type: 'engine/patch', patch: { fps: base.engine.fps } },
      { type: 'ui/patch', patch: { isImageStripOpen: base.ui.isImageStripOpen } },
      {
        type: 'output/patchInspect',
        patch: { zoom: base.output.tracerInspect.zoom },
      },
      {
        type: 'ui/patchVideoExport',
        patch: { fps: base.ui.videoExportSettings.fps },
      },
      {
        type: 'media/patchLiveSource',
        patch: { active: base.media.liveSource.active },
      },
    ] as const;

    for (const action of noops) {
      expect(chromashiftReducer(base, action), `${action.type} allocated a new state`).toBe(base);
    }
  });

  it('still applies a patch that does change something', () => {
    const next = chromashiftReducer(base, {
      type: 'engine/patch',
      patch: { avgLuminance: base.engine.avgLuminance + 1 },
    });
    expect(next).not.toBe(base);
    expect(next.engine.avgLuminance).toBe(base.engine.avgLuminance + 1);
    // Untouched slices keep their identity, so their subscribers stay put.
    expect(next.layers).toBe(base.layers);
    expect(next.media).toBe(base.media);
  });

  it('treats a fresh array or object as a change even when it looks equal', () => {
    // Shallow by design: never swallow a real update behind a deep compare.
    const next = chromashiftReducer(base, {
      type: 'layers/patch',
      patch: { opacities: [...base.layers.opacities] },
    });
    expect(next).not.toBe(base);
  });

  it('bails out when setTriple writes a layer its current value', () => {
    const same = chromashiftReducer(base, {
      type: 'layers/setTriple',
      field: 'angles',
      layer: 1,
      value: base.layers.angles[1],
    });
    expect(same).toBe(base);

    const changed = chromashiftReducer(base, {
      type: 'layers/setTriple',
      field: 'angles',
      layer: 1,
      value: base.layers.angles[1] + 5,
    });
    expect(changed.layers.angles[1]).toBe(base.layers.angles[1] + 5);
    expect(changed.layers.angles[0]).toBe(base.layers.angles[0]);
  });
});
