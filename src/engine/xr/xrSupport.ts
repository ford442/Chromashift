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
  if (typeof window === 'undefined') return;
  const w = window as Window & {
    xrAvailable?: boolean;
    xrImmersiveReason?: string | null;
    xrImmersive?: boolean;
  };
  w.xrAvailable = supported;
  w.xrImmersiveReason = reason;
}

export function publishXrImmersiveBreadcrumb(active: boolean): void {
  if (typeof window === 'undefined') return;
  (window as Window & { xrImmersive?: boolean }).xrImmersive = active;
}

export function isXrImmersiveActive(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as Window & { xrImmersive?: boolean }).xrImmersive === true;
}
