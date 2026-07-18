import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectXrSupport, publishXrBreadcrumbs } from './xrSupport';

describe('xrSupport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports unavailable when navigator.xr is missing', async () => {
    vi.stubGlobal('navigator', {});
    const snap = await detectXrSupport();
    expect(snap.apiPresent).toBe(false);
    expect(snap.immersiveVrSupported).toBe(false);
  });

  it('reports immersive-vr when supported', async () => {
    vi.stubGlobal('navigator', {
      xr: {
        isSessionSupported: vi.fn().mockResolvedValue(true),
      },
    });
    const snap = await detectXrSupport();
    expect(snap.immersiveVrSupported).toBe(true);
    expect(snap.reason).toBeNull();
  });

  it('publishes xrAvailable breadcrumb', () => {
    const stubWindow: Window & { xrAvailable?: boolean; xrImmersiveReason?: string | null } =
      {} as Window & { xrAvailable?: boolean; xrImmersiveReason?: string | null };
    vi.stubGlobal('window', stubWindow);
    publishXrBreadcrumbs(true);
    expect(stubWindow.xrAvailable).toBe(true);
    publishXrBreadcrumbs(false, 'no headset');
    expect(stubWindow.xrAvailable).toBe(false);
    expect(stubWindow.xrImmersiveReason).toBe('no headset');
  });
});
