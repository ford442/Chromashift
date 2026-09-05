/**
 * Render-loop telemetry — angles, CPU/GPU timing, frame history, budget and
 * collision stats — published outside React state.
 *
 * `useAnimationLoop` and the collision-stats poller used to `dispatch()` this
 * data into the reducer 5-20x/sec, which re-rendered the entire component
 * tree (every panel, `ImageStrip`'s few-thousand-entry corpus list, etc.) on
 * every tick even though only a handful of small readouts ever display it.
 * None of it is serialized into presets (see `serializeSettings.ts`), so it
 * never belonged in `ChromashiftState` to begin with.
 *
 * This is a minimal `useSyncExternalStore` store: one slice per independent
 * piece of telemetry, so a component subscribing to (say) CPU timing does
 * not re-render when the frame-time history changes. Writers call `set*`
 * directly (no dispatch, no re-render outside subscribers); readers use the
 * `use*` hooks below.
 */
import { useSyncExternalStore } from 'react';
import type { LayerTriple } from '../state/types';
import { DEFAULT_ANGLES, DEFAULT_COLLISION_STATS } from '../state/defaults';
import { EMPTY_GPU_RENDER_TIMING } from './types/RendererContracts';
import type { GpuRenderTiming } from './types/RendererContracts';
import type { CollisionStats } from './types/RendererState';

type Listener = () => void;

function createSlice<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const anglesSlice = createSlice<LayerTriple<number>>([...DEFAULT_ANGLES]);
const renderCpuTimingSlice = createSlice<{ last: number; avg: number }>({ last: 0, avg: 0 });
const renderGpuTimingSlice = createSlice<GpuRenderTiming>(EMPTY_GPU_RENDER_TIMING);
const frameTimeHistorySlice = createSlice<readonly number[]>([]);
const performanceBudgetExceededSlice = createSlice<boolean>(false);
const collisionStatsSlice = createSlice<CollisionStats>({ ...DEFAULT_COLLISION_STATS });

/** Imperative writers — called from the render loop / pollers, never from React render. */
export const renderTelemetry = {
  setAngles: anglesSlice.set,
  setRenderCpuTiming: renderCpuTimingSlice.set,
  setRenderGpuTiming: renderGpuTimingSlice.set,
  setFrameTimeHistory: frameTimeHistorySlice.set,
  setPerformanceBudgetExceeded: performanceBudgetExceededSlice.set,
  setCollisionStats: collisionStatsSlice.set,
};

/** Live per-layer rotation angle (deg). Only the rotary-knob readouts need this. */
export function useLiveLayerAngle(layer: 0 | 1 | 2): number {
  return useSyncExternalStore(anglesSlice.subscribe, () => anglesSlice.get()[layer]);
}

export function useRenderCpuTiming(): { last: number; avg: number } {
  return useSyncExternalStore(renderCpuTimingSlice.subscribe, renderCpuTimingSlice.get);
}

export function useRenderGpuTiming(): GpuRenderTiming {
  return useSyncExternalStore(renderGpuTimingSlice.subscribe, renderGpuTimingSlice.get);
}

export function useFrameTimeHistory(): readonly number[] {
  return useSyncExternalStore(frameTimeHistorySlice.subscribe, frameTimeHistorySlice.get);
}

export function usePerformanceBudgetExceeded(): boolean {
  return useSyncExternalStore(performanceBudgetExceededSlice.subscribe, performanceBudgetExceededSlice.get);
}

export function useCollisionStats(): CollisionStats {
  return useSyncExternalStore(collisionStatsSlice.subscribe, collisionStatsSlice.get);
}
