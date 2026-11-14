import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { advanceAngles } from '../engine/math/rotation';
import type { ReactiveModulation } from '../engine/reactive/types';
import type { RendererOrchestrator, RendererSlot } from '../engine/RendererOrchestrator';
import type { ChromashiftRenderer, RenderTiming } from '../engine/types/RendererContracts';
import type { RendererState } from '../engine/types/RendererState';
import { renderAppHook } from '../test/renderAppHook';
import { useAnimationLoop } from './useAnimationLoop';

function fakeRenderer(timing: Partial<RenderTiming> = {}) {
  const frames: RendererState[] = [];
  const renderer = {
    backend: 'webgl' as const,
    // The service hands every frame the same object: snapshot it.
    render: vi.fn((state: RendererState) => { frames.push({ ...state, layers: state.layers.map((l) => ({ ...l })) }); }),
    getRenderTiming: vi.fn(() => ({ lastCpuMs: 1, averageCpuMs: 1, gpu: { last: null }, ...timing })),
    setAntialiasing: vi.fn(),
    setTexture: vi.fn(),
    setClassificationMaskTexture: vi.fn(),
    clearPersistence: vi.fn(),
  };
  return { frames, renderer, asRenderer: renderer as unknown as ChromashiftRenderer };
}

/** Just enough orchestrator for the service to boot on and draw the main slot with. */
function fakeOrchestrator(renderer: ChromashiftRenderer): RendererOrchestrator {
  const slot = { id: 'main', canvas: null, renderer } as RendererSlot;
  return {
    getBackend: () => 'webgl',
    getFallbackReason: () => null,
    setPassGraph: vi.fn(),
    setCanvasColorSpace: vi.fn(),
    setCanvasPresentation: vi.fn(),
    getSlot: (id: string) => (id === 'main' ? slot : undefined),
    listSlots: () => [slot],
    reconfigureIfNeeded: vi.fn(),
    resizeAll: vi.fn(),
    destroySlot: vi.fn(),
    destroy: vi.fn(),
    sharedDevice: () => null,
    textureManagerRef: () => null,
    gpuImageAnalysisRef: () => null,
  } as unknown as RendererOrchestrator;
}

/**
 * The loop under the real store and a real in-process render host — the main
 * transport — booted on a fake renderer.
 */
async function setup(timing?: Partial<RenderTiming>) {
  const fake = fakeRenderer(timing);
  const rendered = renderAppHook((refs, store) => useAnimationLoop(refs, store), {
    renderHost: {
      transport: 'main',
      search: () => '',
      serviceDeps: { bootstrap: async () => ({ orchestrator: fakeOrchestrator(fake.asRenderer) }) },
    },
  });
  const { result } = rendered;
  const host = result.current.refs.renderHostRef.current;
  const booted = await act(() => host.boot(document.createElement('canvas'), {
    backend: 'webgl',
    antialias: false,
    colorSpace: 'srgb',
    canvasHdr: false,
    passGraph: 'default',
    retry: false,
  }));
  expect(booted).toMatchObject({ ok: true, backend: 'webgl' });
  const clock = result.current.refs.frameClockRef.current;
  return { ...rendered, ...fake, host, clock };
}

/** …with the GPU ready and the clock offline. */
async function ready(timing?: Partial<RenderTiming>) {
  const context = await setup(timing);
  act(() => context.result.current.store.actions.setGpuReady(true));
  const exitOffline = context.clock.enterOffline(1000);
  const step = (dt: number) => act(() => context.clock.step(dt));
  return { ...context, exitOffline, step };
}

describe('useAnimationLoop through the in-process render host', () => {
  it('the service registers its three tasks once the GPU is ready, and none before', async () => {
    const { result, clock } = await setup();
    expect(clock.size).toBe(0);
    act(() => result.current.store.actions.setGpuReady(true));
    expect(clock.describe()).toMatchObject({
      modulate: ['animation-angles'],
      render: ['main-render'],
      telemetry: ['render-telemetry'],
    });
  });

  it('a video export takes the loop off the clock, and finishing it puts it back', async () => {
    const { result, clock } = await ready();
    act(() => result.current.store.actions.setExportingVideo(true));
    expect(clock.size).toBe(0);
    act(() => result.current.store.actions.setExportingVideo(false));
    expect(clock.size).toBe(3);
  });

  it('unmounting leaves nothing on the clock', async () => {
    const { clock, unmount } = await ready();
    unmount();
    expect(clock.size).toBe(0);
  });

  it('renders on the first tick after registering, whatever the clock reads', async () => {
    // `now - (now - 1000 / 30)` is a hair under a frame for some `now`.
    for (const start of [0, 1000, 1067, 123_456.789]) {
      const { renderer, clock, exitOffline, unmount } = await ready();
      exitOffline();
      const exit = clock.enterOffline(start);
      await act(() => clock.step(0));
      exit();
      expect(renderer.render, `start ${start}`).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('renders at the session fps, whatever the tick rate', async () => {
    const { result, renderer, step } = await ready();
    act(() => result.current.store.actions.setFrameRate(25));
    // 100 ticks of 10 ms is one second: a 40 ms frame is due on 25 of them.
    for (let i = 0; i < 100; i++) await step(10);
    expect(renderer.render).toHaveBeenCalledTimes(25);
  });

  it('advances the layer angles by their extensions once per rendered frame', async () => {
    const { result, host, frames, step } = await ready();
    const { state } = result.current.store;
    const start = [...host.currentAngles()];
    await step(1000 / state.engine.fps);
    const expected = advanceAngles(start, state.layers.extensions, state.engine.fps);
    expect(host.currentAngles()).toEqual(expected);
    expect(frames.at(-1)?.layers.map((layer) => layer.angleDeg)).toEqual(expected);
  });

  it('renders this tick’s reactive modulation, written by the input phase', async () => {
    const { result, clock, host, frames, step } = await ready();
    act(() => result.current.store.dispatch({ type: 'reactive/patch', patch: { enabled: true } }));
    expect(clock.describe().sources).toEqual(['reactive-forward']);
    const mod: ReactiveModulation = {
      extensions: [0, 0, 0],
      tracerAboveIntensity: 0.11,
      tracerBelowIntensity: 0.22,
      avgLuminance: 99,
    };
    const unregister = clock.register('input', () => {
      result.current.refs.reactiveModRef.current = mod;
    }, 'test-input');
    const start = [...host.currentAngles()];

    await step(100);
    unregister();
    expect(frames.at(-1)).toMatchObject({ tracerAboveIntensity: 0.11, tracerBelowIntensity: 0.22, avgLuminance: 99 });
    // The modulated extensions (zero) drove the angles, not the settings'.
    expect(host.currentAngles()).toEqual(start);
  });

  it('with reactive input off, a stale modulation is ignored', async () => {
    const { result, frames, step } = await ready();
    result.current.refs.reactiveModRef.current = {
      extensions: [0, 0, 0], tracerAboveIntensity: 0.11, tracerBelowIntensity: 0.22, avgLuminance: 99,
    };
    await step(100);
    expect(frames.at(-1)?.tracerAboveIntensity).toBe(result.current.store.state.tracers.aboveIntensity);
  });

  it('degrades once when a frame blows its budget with auto-degrade on', async () => {
    const { result, renderer, step } = await ready({ lastCpuMs: 500, averageCpuMs: 500 });
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

  it('a knob drag resets the renderer’s angles to the store’s', async () => {
    const { result, host } = await ready();
    act(() => result.current.store.handleAngleChange(1, 42));
    expect(host.currentAngles()[1]).toBe(42);
  });
});
