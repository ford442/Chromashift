import { describe, expect, it } from 'vitest';
import { TracerInspectPass } from './TracerInspectPass';
import { MAIN_VIEW_MODES } from './viewModes';

describe('TracerInspectPass.drawsMainView', () => {
  it('draws every inspect view, and leaves the processed composite to the compositor', () => {
    expect(TracerInspectPass.drawsMainView(MAIN_VIEW_MODES.PROCESSED_COMPOSITE, 3)).toBe(false);
    for (const view of [
      MAIN_VIEW_MODES.FULL_RES_TRACER,
      MAIN_VIEW_MODES.SOURCE_IMAGE,
      MAIN_VIEW_MODES.LAYER_0,
      MAIN_VIEW_MODES.COINCIDENCE_HEATMAP,
      MAIN_VIEW_MODES.COMPARE_SOURCE_COMPOSITE,
      MAIN_VIEW_MODES.STAMP_DIAGNOSTICS,
    ]) {
      expect(TracerInspectPass.drawsMainView(view, 3), String(view)).toBe(true);
    }
  });

  it('shows a layer view only of a layer the frame has', () => {
    expect(TracerInspectPass.drawsMainView(MAIN_VIEW_MODES.LAYER_1, 2)).toBe(true);
    expect(TracerInspectPass.drawsMainView(MAIN_VIEW_MODES.LAYER_2, 2)).toBe(false);
  });
});
