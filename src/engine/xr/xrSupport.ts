import { publishDiagnostic, publishDiagnostics, readDiagnostic } from '../diagnostics';

export interface XrSupportSnapshot {
  /** `navigator.xr` is present. */
  apiPresent: boolean;
  /** `immersive-vr` session is supported (async probe result). */
  immersiveVrSupported: boolean;
  reason: string | null;
}

/** Probe WebXR immersive-vr support. Safe to call without hardware. */
export async function detectXrSupport(): Promise<XrSupportSnapshot> {
  if (typeof navigator === 'undefined' || !('xr' in navigator) || !navigator.xr) {
    return {
      apiPresent: false,
      immersiveVrSupported: false,
      reason: 'navigator.xr unavailable',
    };
  }

  try {
    const immersiveVrSupported = await navigator.xr.isSessionSupported('immersive-vr');
    return {
      apiPresent: true,
      immersiveVrSupported,
      reason: immersiveVrSupported ? null : 'immersive-vr not supported',
    };
  } catch (err) {
    return {
      apiPresent: true,
      immersiveVrSupported: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Automation breadcrumb — true when immersive-vr is supported. */
export function publishXrBreadcrumbs(supported: boolean, reason: string | null = null): void {
  publishDiagnostics({ xrAvailable: supported, xrImmersiveReason: reason });
}

export function publishXrImmersiveBreadcrumb(active: boolean): void {
  publishDiagnostic('xrImmersive', active);
}

export function isXrImmersiveActive(): boolean {
  return readDiagnostic('xrImmersive') === true;
}
