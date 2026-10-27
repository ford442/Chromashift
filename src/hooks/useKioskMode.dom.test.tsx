import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attractValues } from '../engine/kioskMode';
import { renderAppHook } from '../test/renderAppHook';
import { useKioskMode } from './useKioskMode';

const render = () => renderAppHook((refs, store) => useKioskMode(refs, store));
type Rendered = ReturnType<typeof render>['result'];

const press = (key: string, init: KeyboardEventInit = {}, target: Window | Element = window) =>
  act(() => { fireEvent.keyDown(target, { key, ...init }); });

function enterKiosk(result: Rendered, patch: { kioskUiHidden?: boolean; kioskAttractMode?: boolean } = {}) {
  act(() => {
    result.current.store.dispatch({ type: 'ui/patch', patch: { kioskEnabled: true, ...patch } });
  });
}

let fullscreenElement: Element | null = null;
const exitFullscreen = vi.fn(() => {
  fullscreenElement = null;
  return Promise.resolve();
});

beforeEach(() => {
  fullscreenElement = null;
  exitFullscreen.mockClear();
  Object.defineProperty(document, 'fullscreenElement', { get: () => fullscreenElement, configurable: true });
  Object.defineProperty(document, 'exitFullscreen', { value: exitFullscreen, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'fullscreenElement');
  Reflect.deleteProperty(document, 'exitFullscreen');
  Reflect.deleteProperty(navigator, 'wakeLock');
});

describe('useKioskMode — keyboard', () => {
  it('? toggles the shortcuts overlay and Escape closes it', () => {
    const { result } = render();
    press('?');
    expect(result.current.store.state.ui.shortcutsOverlayVisible).toBe(true);
    press('/', { shiftKey: true });
    expect(result.current.store.state.ui.shortcutsOverlayVisible).toBe(false);
    press('?');
    press('Escape');
    expect(result.current.store.state.ui.shortcutsOverlayVisible).toBe(false);
  });

  it('Escape brings hidden kiosk chrome back and leaves fullscreen', () => {
    const { result } = render();
    enterKiosk(result, { kioskUiHidden: true });
    press('Escape');
    expect(result.current.store.state.ui.kioskUiHidden).toBe(false);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('ignores keys typed into a form field', () => {
    const { result } = render();
    const input = document.createElement('input');
    document.body.append(input);
    press('?', {}, input);
    expect(result.current.store.state.ui.shortcutsOverlayVisible).toBe(false);
    input.remove();
  });

  it('F asks the container for fullscreen', () => {
    const { result } = render();
    const container = document.createElement('div');
    const requestFullscreen = vi.fn(() => Promise.resolve());
    container.requestFullscreen = requestFullscreen;
    result.current.refs.containerRef.current = container as HTMLDivElement;
    press('f');
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });
});

describe('useKioskMode — fullscreen and wake lock', () => {
  it('reports fullscreen and holds a screen wake lock only while the container is fullscreen', async () => {
    const release = vi.fn(() => Promise.resolve());
    const request = vi.fn(() => Promise.resolve({ release } as unknown as WakeLockSentinel));
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    const { result } = render();
    const container = document.createElement('div');
    result.current.refs.containerRef.current = container as HTMLDivElement;

    fullscreenElement = container;
    await act(async () => { document.dispatchEvent(new Event('fullscreenchange')); });
    expect(result.current.value.isFullscreen).toBe(true);
    expect(request).toHaveBeenCalledWith('screen');

    fullscreenElement = null;
    await act(async () => { document.dispatchEvent(new Event('fullscreenchange')); });
    expect(result.current.value.isFullscreen).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('useKioskMode — the show keeps running', () => {
  it('unpauses when kiosk hides the chrome', () => {
    const { result } = render();
    act(() => result.current.store.actions.setIsPaused(true));
    enterKiosk(result, { kioskUiHidden: true });
    expect(result.current.store.state.engine.paused).toBe(false);
  });

  it('a paused session outside kiosk stays paused', () => {
    const { result } = render();
    act(() => result.current.store.actions.setIsPaused(true));
    enterKiosk(result);
    expect(result.current.store.state.engine.paused).toBe(true);
  });

  it('attract mode drifts the parameters on its tick, and stops when the chrome returns', () => {
    vi.useFakeTimers();
    const { result } = render();
    enterKiosk(result, { kioskUiHidden: true, kioskAttractMode: true });
    const before = result.current.store.state.tracers.aboveIntensity;

    act(() => { vi.advanceTimersByTime(2000); });
    // Fake timers fake `performance.now()` too, so the first tick is t = 2 s.
    const expected = Object.fromEntries(attractValues(2).map(({ path, value }) => [path, value]));
    const { state } = result.current.store;
    expect(state.tracers.aboveIntensity).toBeCloseTo(expected['tracers.aboveIntensity']!, 12);
    expect(state.tracers.belowIntensity).toBeCloseTo(expected['tracers.belowIntensity']!, 12);
    expect(state.engine.avgLuminance).toBe(expected['engine.avgLuminance']);
    const drifted = state.tracers.aboveIntensity;
    expect(drifted).not.toBe(before);

    act(() => result.current.store.actions.setKioskUiHidden(false));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.store.state.tracers.aboveIntensity).toBe(drifted);
  });

  it('publishes the kiosk breadcrumb', () => {
    const { result } = render();
    expect(window.kioskMode).toBe(false);
    enterKiosk(result);
    expect(window.kioskMode).toBe(true);
  });
});
