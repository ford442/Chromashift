/**
 * Debug breadcrumb for counting React re-renders.
 *
 * The point of the subscription model (telemetry store + per-panel prop
 * slices — see `engine/telemetryStore.ts` and `components/overlay/panelProps.ts`)
 * is that a steady-state session re-renders nothing. That is easy to regress
 * silently, so `useRenderCount` makes it observable without React DevTools:
 * every instrumented component bumps a counter on `window.__renderCounts`.
 *
 * Disabled by default and free when off — the hook early-returns before
 * touching the ref, so the only cost in a normal session is one boolean read
 * per component render. Enable with `?debugRenders=1` (or
 * `localStorage.setItem('chromashift:debugRenders', '1')`), reload, then:
 *
 *     __renderCounts.reset();          // zero the counters
 *     // ... leave the app running ...
 *     __renderCounts.snapshot();       // { ImageStrip: 0, TracerPanel: 0, ... }
 *
 * Note: React StrictMode double-invokes render in dev, so dev counts are 2x
 * the commit count. Only the *zero vs. non-zero* distinction matters here.
 */
export interface RenderCountsApi {
  /** Raw per-component render tallies since the last `reset()`. */
  readonly counts: Record<string, number>;
  /** Plain-object copy of `counts`, safe to log or diff. */
  snapshot(): Record<string, number>;
  /** Zero every counter (keeps the keys, so an idle window reads as all-zero). */
  reset(): void;
}

declare global {
  var __renderCounts: RenderCountsApi | undefined;
}

function readFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('debugRenders') === '1') return true;
    return window.localStorage.getItem('chromashift:debugRenders') === '1';
  } catch {
    // Opaque origin, disabled storage, or a non-DOM test environment.
    return false;
  }
}

const enabled = readFlag();

const counts: Record<string, number> = {};

export const renderCounts: RenderCountsApi = {
  counts,
  snapshot: () => ({ ...counts }),
  reset() {
    for (const key of Object.keys(counts)) counts[key] = 0;
  },
};

/** True when the breadcrumb is armed for this session. */
export function isRenderCountDebugEnabled(): boolean {
  return enabled;
}

if (enabled && typeof window !== 'undefined') {
  window.__renderCounts = renderCounts;
}

/**
 * Tally a render of `name` on `window.__renderCounts` when the debug flag is on.
 *
 * Call it unconditionally at the top of a component — it is a hook, so it must
 * not sit behind a branch. Counting in the render body (rather than an effect)
 * is deliberate: a render React later discards still costs the CPU this
 * breadcrumb exists to account for.
 */
export function useRenderCount(name: string): void {
  if (!enabled) return;
  counts[name] = (counts[name] ?? 0) + 1;
}
