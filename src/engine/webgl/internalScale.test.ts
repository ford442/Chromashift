import { describe, expect, it } from 'vitest';
import {
  WEBGL_INTERNAL_EDGE_CAP,
  WEBGL_SCALE_OVER_FRAMES,
  WEBGL_SCALE_UNDER_FRAMES,
  WEBGL_SCALE_WARMUP_FRAMES,
  createWebglScaleController,
  stepWebglInternalScale,
  webglBaseInternalScale,
} from './internalScale';

describe('webglBaseInternalScale', () => {
  it('leaves canvases inside the edge cap at full resolution', () => {
    expect(webglBaseInternalScale(800, 600)).toBe(1);
    expect(webglBaseInternalScale(WEBGL_INTERNAL_EDGE_CAP, 400)).toBe(1);
  });

  it('caps the long edge', () => {
    expect(webglBaseInternalScale(2000, 1200)).toBeCloseTo(WEBGL_INTERNAL_EDGE_CAP / 2000);
    expect(webglBaseInternalScale(1000, 1920)).toBeCloseTo(WEBGL_INTERNAL_EDGE_CAP / 1920);
  });
});

describe('stepWebglInternalScale', () => {
  it('holds the cap through the warmup, then steps down while frames miss the budget', () => {
    const controller = createWebglScaleController();
    const budget = 33;
    const primed = stepWebglInternalScale(controller, 2000, 2000, null, budget);
    expect(primed).toBeCloseTo(WEBGL_INTERNAL_EDGE_CAP / 2000);

    for (let i = 0; i < WEBGL_SCALE_WARMUP_FRAMES; i += 1) {
      expect(stepWebglInternalScale(controller, 2000, 2000, 150, budget)).toBeCloseTo(primed);
    }

    let scale = primed;
    for (let i = 0; i < WEBGL_SCALE_OVER_FRAMES - 1; i += 1) {
      scale = stepWebglInternalScale(controller, 2000, 2000, 150, budget);
    }
    expect(scale).toBeCloseTo(primed);
    scale = stepWebglInternalScale(controller, 2000, 2000, 150, budget);
    expect(scale).toBeCloseTo(Math.round(primed * 0.75 * 100) / 100);
  });

  it('steps back up toward the cap after a run of cheap frames', () => {
    const controller = createWebglScaleController();
    stepWebglInternalScale(controller, 2000, 2000, null, 33);
    for (let i = 0; i < WEBGL_SCALE_WARMUP_FRAMES + WEBGL_SCALE_OVER_FRAMES; i += 1) {
      stepWebglInternalScale(controller, 2000, 2000, 150, 33);
    }
    const dropped = controller.scale;
    expect(dropped).toBeLessThan(WEBGL_INTERNAL_EDGE_CAP / 2000);

    let scale = dropped;
    for (let i = 0; i < WEBGL_SCALE_UNDER_FRAMES; i += 1) {
      scale = stepWebglInternalScale(controller, 2000, 2000, 1, 33);
    }
    expect(scale).toBeGreaterThan(dropped);
    expect(scale).toBeLessThanOrEqual(WEBGL_INTERNAL_EDGE_CAP / 2000 + 1e-9);
  });

  it('resets to the cap when the canvas edge changes', () => {
    const controller = createWebglScaleController();
    stepWebglInternalScale(controller, 2000, 2000, null, 33);
    for (let i = 0; i < WEBGL_SCALE_WARMUP_FRAMES + WEBGL_SCALE_OVER_FRAMES; i += 1) {
      stepWebglInternalScale(controller, 2000, 2000, 200, 33);
    }
    expect(controller.scale).toBeLessThan(1);
    expect(stepWebglInternalScale(controller, 640, 640, 200, 33)).toBe(1);
  });
});
