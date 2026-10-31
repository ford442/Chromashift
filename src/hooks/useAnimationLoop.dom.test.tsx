import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { advanceAngles } from '../engine/math/rotation';
import type { ReactiveModulation } from '../engine/reactive/types';
import type { ChromashiftRenderer, RenderTiming } from '../engine/types/RendererContracts';
import type { RendererState } from '../engine/types/RendererState';
import { renderAppHook } from '../test/renderAppHook';
import { useAnimationLoop } from './useAnimationLoop';

function fakeRenderer(timing: Partial<RenderTiming> = {}) {
  const frames: RendererState[] = [];
  const renderer = {
    render: vi.fn((state: RendererState) => { frames.push(state); }),
    getRenderTiming: vi.fn(() => ({ lastCpuMs: 1, averageCpuMs: 1, gpu: { last: null }, ...timing })),
    setAntialiasing: vi.fn(),
  };
  return { frames, renderer, asRenderer: renderer as unknown as ChromashiftRenderer };
}

/** The loop under the real store, with a fake renderer, GPU ready and the clock offline. */
function setup(timing?: Partial<RenderTiming>) {
  const rendered = renderAppHook((refs, store) => useAnimationLoop(refs, store));
  const { result } = rendered;
  const fake = fakeRenderer(timing);
  result.current.refs.rendererRef.current = fake.asRenderer;
  act(() => result.current.store.actions.setGpuReady(true));
  const clock = result.current.refs.frameClockRef.current;
  const exitOffline = clock.enterOffline(1000);
  const step = (dt: number) => act(() => clock.step(dt));
  return { ...rendered, ...fake, clock, exitOffline, step };
}

describe('useAnimationLoop on the frame clock', () => {
  it('registers its three tasks once the GPU is ready, and none before', () => {
    const { result } = renderAppHook((refs, store) => useAnimationLoop(refs, store));
    const clock = result.current.refs.frameClockRef.current;
    expect(clock.size).toBe(0);
    act(() => result.current.store.actions.setGpuReady(true));
    expect(clock.describe()).toMatchObject({
      modulate: ['animation-angles'],
      render: ['main-render'],
      telemetry: ['render-telemetry'],
    });
  });

  it('a video export takes the loop off the clock, and finishing it puts it back', () => {
    const { result, clock } = setup();
    act(() => result.current.store.actions.setExportingVideo(true));
    expect(clock.size).toBe(0);
    act(() => result.current.store.actions.setExportingVideo(false));
    expect(clock.size).toBe(3);
  });

  it('unmounting leaves nothing on the clock', () => {
    const { clock, unmount } = setup();
    unmount();
    expect(clock.size).toBe(0);
  });

  it('renders on the first tick after registering, whatever the clock reads', async () => {
    // `now - (now - 1000 / 30)` is a hair under a frame for some `now`.
    for (const start of [0, 1000, 1067, 123_456.789]) {
      const { renderer, clock, exitOffline, unmount } = setup();
      exitOffline();
      const exit = clock.enterOffline(start);
      await act(() => clock.step(0));
      exit();
      expect(renderer.render, `start ${start}`).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('renders at the session fps, whatever the tick rate', async () => {
    const { result, renderer, step } = setup();
    act(() => result.current.store.actions.setFrameRate(25));
    // 100 ticks of 10 ms is one second: a 40 ms frame is due on 25 of them.
    for (let i = 0; i < 100; i++) await step(10);
    expect(renderer.render).toHaveBeenCalledTimes(25);
  });

  it('advances the layer angles by their extensions once per rendered frame', async () => {
    const { result, step } = setup();
    const { state } = result.current.store;
    const start = [...result.current.refs.animAnglesRef.current];
    await step(1000 / state.engine.fps);
    expect(result.current.refs.animAnglesRef.current)
      .toEqual(advanceAngles(start, state.layers.extensions, state.engine.fps));
  });

  it('renders this tick’s reactive modulation, written by the input phase', async () => {
    const { result, clock, frames, step } = setup();
    act(() => result.current.store.dispatch({ type: 'reactive/patch', patch: { enabled: true } }));
    const mod: ReactiveModulation = {
      extensions: [0, 0, 0],
      tracerAboveIntensity: 0.11,
      tracerBelowIntensity: 0.22,
      avgLuminance: 99,
    };
    const unregister = clock.register('input', () => {
      result.current.refs.reactiveModRef.current = mod;
    }, 'test-input');
    const start = [...result.current.refs.animAnglesRef.current];

    await step(100);
    unregister();
    expect(frames.at(-1)).toMatchObject({ tracerAboveIntensity: 0.11, tracerBelowIntensity: 0.22, avgLuminance: 99 });
    // The modulated extensions (zero) drove the angles, not the settings'.
    expect(result.current.refs.animAnglesRef.current).toEqual(start);
  });

  it('with reactive input off, a stale modulation is ignored', async () => {
    const { result, frames, step } = setup();
    result.current.refs.reactiveModRef.current = {
      extensions: [0, 0, 0], tracerAboveIntensity: 0.11, tracerBelowIntensity: 0.22, avgLuminance: 99,
    };
    await step(100);
    expect(frames.at(-1)?.tracerAboveIntensity).toBe(result.current.store.state.tracers.aboveIntensity);
  });

  it('degrades once when a frame blows its budget with auto-degrade on', async () => {
    const { result, renderer, step } = setup({ lastCpuMs: 500, averageCpuMs: 500 });
    act(() => {
      result.current.store.dispatch({ type: 'output/patch', patch: { performanceHudEnabled: true, performanceAutoDegrade: true } });
    });
    const tracerScale = result.current.store.state.tracers.scale;

    await step(300);
    expect(renderer.setAntialiasing).toHaveBeenCalledWith(false);
    expect(result.current.store.state.tracers.scale).toBeLessThan(tracerScale);

    await step(300);
    expect(renderer.setAntialiasing).toHaveBeenCalledTimes(1);
  });
});
