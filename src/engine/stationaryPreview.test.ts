import { describe, expect, it } from 'vitest';
import { createInitialState } from '../state/defaults';
import { buildRendererState } from './buildRendererState';
import { MAX_LAYER_COUNT } from './graph/layerSpecs';
import {
  STATIONARY_PREVIEW_SIZE,
  STATIONARY_TRACER_WARMUP_FRAMES,
  planStationaryPreview,
  separatedPreviewState,
  tracerWarmupState,
} from './stationaryPreview';
import type { RendererState } from './types/RendererState';
import { MAIN_VIEW_MODES } from './viewModes';

const base = (overrides: Partial<RendererState> = {}): RendererState => {
  const state = createInitialState();
  return { ...buildRendererState(state, state.layers.angles as number[]), ...overrides };
};

describe('planStationaryPreview', () => {
  it('fills the defaults and draws at the thumbnail’s own scale', () => {
    const plan = planStationaryPreview(base({ layerScale: 0.5, tracerScale: 0.25 }));
    expect(plan).toMatchObject({
      size: STATIONARY_PREVIEW_SIZE,
      fps: 30,
      warmupFrames: STATIONARY_TRACER_WARMUP_FRAMES,
      separated: true,
      tracer: true,
    });
    expect(plan.state.layerScale).toBe(1);
    expect(plan.state.tracerScale).toBe(1);
  });

  it('honours the options and clamps the layer count to what a graph builds', () => {
    const many = base({ layers: Array.from({ length: MAX_LAYER_COUNT + 3 }, () => base().layers[0]) });
    const plan = planStationaryPreview(many, { fps: 12, tracerWarmupFrames: 3, separated: false, tracer: false });
    expect(plan).toMatchObject({ fps: 12, warmupFrames: 3, separated: false, tracer: false, layerCount: MAX_LAYER_COUNT });
  });
});

describe('preview states', () => {
  const session = base({
    paused: false,
    tracerAboveIntensity: 0.8,
    diagnosticsMode: true,
    diagnosticsOpacity: 0.6,
    mainViewMode: MAIN_VIEW_MODES.FULL_RES_TRACER,
    viewportQuarterZoom: true,
  });

  it('Separated is the composite alone, as a still', () => {
    expect(separatedPreviewState(session)).toMatchObject({
      tracerAboveIntensity: 0,
      tracerBelowIntensity: 0,
      mainViewMode: MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
      viewportQuarterZoom: false,
      viewportHalfOverlay: false,
      diagnosticsMode: false,
      diagnosticsOpacity: 0,
      paused: true,
    });
  });

  it('the tracer warmup accumulates even from a paused preview', () => {
    expect(tracerWarmupState({ ...session, paused: true }).paused).toBe(false);
  });
});
