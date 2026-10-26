import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeAudioModulation } from '../engine/reactive/modulation';
import type { AudioLevelSnapshot } from '../engine/reactive/types';
import { paramFromUnit, paramSpec } from '../state/params';
import type { ChromashiftState } from '../state/types';
import { renderAppHook } from '../test/renderAppHook';
import { useReactiveInput } from './useReactiveInput';

type CcHandler = (channel: number, controller: number, value: number) => void;

// The capture classes own the browser APIs (getUserMedia, Web MIDI); the hook
// is what decides when they run and what their samples do, so fake them.
const fakes = vi.hoisted(() => ({
  levels: { bass: 0.8, mid: 0.4, high: 0.2, energy: 0.6 } as AudioLevelSnapshot,
  micFailure: null as Error | null,
  analysers: [] as { stopped: boolean }[],
  onCc: null as CcHandler | null,
}));

vi.mock('../engine/reactive/AudioAnalyser', () => ({
  AudioAnalyser: class {
    stopped = false;
    private started = false;
    constructor() { fakes.analysers.push(this); }
    get isActive() { return this.started && !this.stopped; }
    startMic() {
      if (fakes.micFailure) return Promise.reject(fakes.micFailure);
      this.started = true;
      return Promise.resolve();
    }
    sample() { return fakes.levels; }
    stop() { this.stopped = true; return Promise.resolve(); }
  },
}));

vi.mock('../engine/reactive/MidiController', async (importOriginal) => ({
  ...await importOriginal<typeof import('../engine/reactive/MidiController')>(),
  MidiController: class {
    start(onCc: CcHandler) { fakes.onCc = onCc; return Promise.resolve(); }
    stop() { fakes.onCc = null; return Promise.resolve(); }
  },
}));

const render = () => renderAppHook((refs, store) => useReactiveInput(refs, store));
type Rendered = ReturnType<typeof render>['result'];

const patchReactive = (result: Rendered, patch: Partial<ChromashiftState['reactive']>) =>
  act(() => { result.current.store.dispatch({ type: 'reactive/patch', patch }); });

const clockOf = (result: Rendered) => result.current.refs.frameClockRef.current;

const mediaDevices = { getUserMedia: () => Promise.reject(new Error('not used: AudioAnalyser is faked')) };

beforeEach(() => {
  fakes.micFailure = null;
  fakes.analysers.length = 0;
  fakes.onCc = null;
  Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('useReactiveInput — audio', () => {
  it('registers nothing on the frame clock while reactive input is off', () => {
    const { result } = render();
    expect(clockOf(result).size).toBe(0);
    expect(result.current.refs.reactiveModRef.current).toBeNull();
  });

  it('opens the mic, and its input task writes this tick’s modulation before modulate reads it', async () => {
    const { result } = render();
    patchReactive(result, { enabled: true, audioEnabled: true });
    await waitFor(() => expect(result.current.store.state.reactive.micActive).toBe(true));
    const clock = clockOf(result);
    expect(clock.describe()).toMatchObject({ input: ['audio-input'], telemetry: ['audio-meters'] });

    let seenByModulate: unknown = 'not run';
    const unregister = clock.register('modulate', () => {
      seenByModulate = result.current.refs.reactiveModRef.current;
    });
    const exitOffline = clock.enterOffline(1000);
    await act(() => clock.step(16));
    exitOffline();
    unregister();

    const expected = computeAudioModulation(result.current.store.getState(), fakes.levels);
    expect(seenByModulate).toEqual(expected);
    // Telemetry pushed the meters to the store for the panel to draw.
    expect(result.current.store.state.reactive.audioLevels).toEqual(fakes.levels);
  });

  it('reports a mic failure and leaves the modulation unset', async () => {
    fakes.micFailure = new Error('Permission denied');
    const { result } = render();
    patchReactive(result, { enabled: true, audioEnabled: true });
    await waitFor(() => expect(result.current.store.state.reactive.micError).toBe('Permission denied'));
    expect(result.current.store.state.reactive.micActive).toBe(false);

    const clock = clockOf(result);
    const exitOffline = clock.enterOffline();
    await act(() => clock.step(16));
    exitOffline();
    expect(result.current.refs.reactiveModRef.current).toBeNull();
  });

  it('says so when the browser has no microphone API', () => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    const { result } = render();
    patchReactive(result, { enabled: true, audioEnabled: true });
    expect(result.current.store.state.reactive.micError).toBe('Microphone not supported');
    expect(fakes.analysers).toHaveLength(0);
  });

  it('the kill switch stops the mic, unregisters from the clock and clears the modulation', async () => {
    const { result } = render();
    patchReactive(result, { enabled: true, audioEnabled: true });
    await waitFor(() => expect(result.current.store.state.reactive.micActive).toBe(true));
    const clock = clockOf(result);
    const exitOffline = clock.enterOffline();
    await act(() => clock.step(16));
    exitOffline();
    expect(result.current.refs.reactiveModRef.current).not.toBeNull();

    patchReactive(result, { enabled: false });
    await waitFor(() => expect(result.current.store.state.reactive.micActive).toBe(false));
    expect(clock.size).toBe(0);
    expect(result.current.refs.reactiveModRef.current).toBeNull();
    expect(fakes.analysers.every((analyser) => analyser.stopped)).toBe(true);
  });

  it('switching off and straight back on keeps the new capture', async () => {
    const { result } = render();
    patchReactive(result, { enabled: true, audioEnabled: true, midiEnabled: true });
    await waitFor(() => expect(result.current.store.state.reactive.micActive).toBe(true));

    // Both in one task: the off branch's teardown is still pending when the
    // on branch starts new capture, and must not stop it.
    act(() => {
      result.current.store.dispatch({ type: 'reactive/patch', patch: { enabled: false } });
      result.current.store.dispatch({ type: 'reactive/patch', patch: { enabled: true } });
    });
    await waitFor(() => expect(result.current.store.state.reactive.micActive).toBe(true));
    const live = fakes.analysers.filter((analyser) => !analyser.stopped);
    expect(live).toHaveLength(1);
    expect(fakes.onCc).not.toBeNull();

    const clock = clockOf(result);
    const exitOffline = clock.enterOffline();
    await act(() => clock.step(16));
    exitOffline();
    expect(result.current.refs.reactiveModRef.current).not.toBeNull();
  });

  it('unmounting leaves nothing on the clock', async () => {
    const { result, unmount } = render();
    patchReactive(result, { enabled: true, audioEnabled: true });
    await waitFor(() => expect(result.current.store.state.reactive.micActive).toBe(true));
    const clock = clockOf(result);
    unmount();
    expect(clock.size).toBe(0);
  });
});

describe('useReactiveInput — MIDI', () => {
  const top = paramFromUnit(paramSpec('tracers.aboveIntensity'), 1);

  it('MIDI learn binds the next CC to the target and applies it', async () => {
    const { result } = render();
    patchReactive(result, { enabled: true, midiEnabled: true, midiLearnTarget: 'tracers.aboveIntensity' });
    await waitFor(() => expect(fakes.onCc).not.toBeNull());

    act(() => fakes.onCc!(2, 74, 127));
    const { reactive, tracers } = result.current.store.state;
    expect(reactive.midiBindings).toContainEqual({ channel: 2, controller: 74, param: 'tracers.aboveIntensity' });
    expect(reactive.midiLearnTarget).toBeNull();
    expect(tracers.aboveIntensity).toBe(top);
  });

  it('learns and drives layer 7 at layers.count = 10 (#226 acceptance)', async () => {
    const { result } = render();
    act(() => { result.current.store.dispatch({ type: 'layers/setCount', count: 10 }); });
    patchReactive(result, { enabled: true, midiEnabled: true, midiLearnTarget: 'layers.extensions.7' });
    await waitFor(() => expect(fakes.onCc).not.toBeNull());
    const before = [...result.current.store.state.layers.extensions];

    act(() => fakes.onCc!(0, 21, 64));
    act(() => fakes.onCc!(0, 21, 127));
    const { reactive, layers } = result.current.store.state;
    expect(reactive.midiBindings).toEqual([{ channel: 0, controller: 21, param: 'layers.extensions.7' }]);
    expect(layers.extensions[7]).toBe(paramFromUnit(paramSpec('layers.extensions.7'), 1));
    const others = (values: number[]) => values.filter((_, i) => i !== 7);
    expect(others(layers.extensions)).toEqual(others(before));
  });

  it('a bound CC drives its parameter; an unbound one does nothing', async () => {
    const { result } = render();
    patchReactive(result, {
      enabled: true,
      midiEnabled: true,
      midiBindings: [{ channel: -1, controller: 10, param: 'tracers.aboveIntensity' }],
    });
    await waitFor(() => expect(fakes.onCc).not.toBeNull());
    const before = result.current.store.state;

    act(() => fakes.onCc!(5, 11, 127));
    expect(result.current.store.state.tracers).toBe(before.tracers);

    act(() => fakes.onCc!(5, 10, 0));
    expect(result.current.store.state.tracers.aboveIntensity)
      .toBe(paramFromUnit(paramSpec('tracers.aboveIntensity'), 0));
  });

  it('turning MIDI off stops listening', async () => {
    const { result } = render();
    patchReactive(result, { enabled: true, midiEnabled: true });
    await waitFor(() => expect(fakes.onCc).not.toBeNull());
    patchReactive(result, { midiEnabled: false });
    await waitFor(() => expect(fakes.onCc).toBeNull());
  });
});
