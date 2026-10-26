import { publishDiagnostic } from './diagnostics';
import type { ParamPath } from '../state/params';

export const KIOSK_URL_PARAM = 'kiosk';

/** True when `?kiosk=1`, `?kiosk=true`, or `?kiosk` is present. */
export function isKioskModeSearch(search: string): boolean {
  try {
    const value = new URLSearchParams(search).get(KIOSK_URL_PARAM);
    if (value === null) return false;
    if (value === '') return true;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  } catch {
    return false;
  }
}

export function publishKioskBreadcrumbs(enabled: boolean): void {
  publishDiagnostic('kioskMode', enabled);
}

/**
 * The attract loop's slow drift: each parameter swings `amplitude` around
 * `center` with its own period, so the combined look never quite repeats.
 */
export const ATTRACT_DRIFT: readonly {
  path: ParamPath;
  center: number;
  amplitude: number;
  periodSec: number;
  phase: number;
  /** Round to whole units (luminance is sampled as an integer elsewhere). */
  whole?: boolean;
}[] = [
  { path: 'tracers.aboveIntensity', center: 0.78, amplitude: 0.12, periodSec: 45, phase: 0 },
  { path: 'tracers.belowIntensity', center: 0.28, amplitude: 0.08, periodSec: 62, phase: 1 },
  { path: 'output.stampBoost', center: 1.6, amplitude: 0.6, periodSec: 90, phase: 2 },
  { path: 'engine.avgLuminance', center: 120, amplitude: 18, periodSec: 75, phase: 0.5, whole: true },
];

/** Where the attract drift puts each parameter `t` seconds in (pure — no clock). */
export function attractValues(t: number): { path: ParamPath; value: number }[] {
  return ATTRACT_DRIFT.map(({ path, center, amplitude, periodSec, phase, whole }) => {
    const value = center + amplitude * Math.sin(t / periodSec + phase);
    return { path, value: whole ? Math.round(value) : value };
  });
}
