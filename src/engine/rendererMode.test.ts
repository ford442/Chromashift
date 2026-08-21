import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WEBGL_BACKEND_ENABLED,
  getRendererPreference,
  getStoredRendererPreference,
  isWebGlRequestIgnored,
  openWebGlDiagnosticSession,
  publishRendererBootFailure,
  publishRendererBreadcrumbs,
  readRequestedBackend,
  setStoredRendererPreference,
  switchRendererPreference,
} from './rendererMode';

const STORAGE_KEY = 'chromashift.renderer';

function installBrowserGlobals(search = '') {
  const storage = new Map<string, string>();
  const win = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => { storage.clear(); },
    },
    location: {
      search,
      href: `http://localhost:5173/${search}`,
      assign: vi.fn(),
    },
    rendererType: undefined as string | undefined,
    usingWebGPU: undefined as boolean | undefined,
    usingWebGL: undefined as boolean | undefined,
    rendererFallbackReason: undefined as string | null | undefined,
  };

  vi.stubGlobal('window', win);
  vi.stubGlobal('localStorage', win.localStorage);
  vi.stubGlobal('location', win.location);
  return win;
}

describe('getRendererPreference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('honours explicit ?renderer=webgl as a diagnostic session', () => {
    expect(WEBGL_BACKEND_ENABLED).toBe(true);
    installBrowserGlobals('?renderer=webgl');
    expect(getRendererPreference()).toBe('webgl');
    expect(readRequestedBackend()).toBe('webgl');
    expect(isWebGlRequestIgnored()).toBe(false);
  });

  it('prefers explicit ?renderer=webgpu', () => {
    installBrowserGlobals('?renderer=webgpu');
    expect(getRendererPreference()).toBe('webgpu');
    expect(isWebGlRequestIgnored()).toBe(false);
  });

  it('honours the bare ?webgl flag', () => {
    installBrowserGlobals('?webgl');
    expect(getRendererPreference()).toBe('webgl');
    expect(readRequestedBackend()).toBe('webgl');
  });

  it('defaults to webgpu with no query or stored preference', () => {
    installBrowserGlobals('');
    expect(getRendererPreference()).toBe('webgpu');
  });

  it('honours a stored webgl preference without treating it as fallback', () => {
    installBrowserGlobals('');
    setStoredRendererPreference('webgl');
    expect(getRendererPreference()).toBe('webgl');
  });

  it('lets an explicit webgpu query override a stored webgl preference', () => {
    installBrowserGlobals('?renderer=webgpu');
    setStoredRendererPreference('webgl');
    expect(getRendererPreference()).toBe('webgpu');
  });
});

describe('switchRendererPreference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists webgl and navigates to ?renderer=webgl', () => {
    const win = installBrowserGlobals('');
    switchRendererPreference('webgl');
    expect(getStoredRendererPreference()).toBe('webgl');
    expect(win.location.assign).toHaveBeenCalledWith(
      expect.stringContaining('renderer=webgl'),
    );
  });

  it('openWebGlDiagnosticSession is a named navigation, not an in-place switch', () => {
    const win = installBrowserGlobals('?renderer=webgpu');
    openWebGlDiagnosticSession();
    expect(String((win.location.assign as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain('renderer=webgl');
  });
});

describe('publishRendererBootFailure', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pins usingWebGL false so a hard fail is not read as a fallback', () => {
    const win = installBrowserGlobals('') as unknown as Record<string, unknown>;
    publishRendererBootFailure('[adapter] No WebGPU adapter found.');

    expect(win.usingWebGPU).toBe(false);
    expect(win.usingWebGL).toBe(false);
    expect(win.rendererType).toBeNull();
    expect(win.rendererFallbackReason).toContain('No WebGPU adapter');
  });
});

describe('localStorage preference', () => {
  beforeEach(() => {
    installBrowserGlobals('');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips valid renderer values', () => {
    setStoredRendererPreference('webgl');
    expect(getStoredRendererPreference()).toBe('webgl');
    setStoredRendererPreference('webgpu');
    expect(getStoredRendererPreference()).toBe('webgpu');
  });

  it('ignores invalid stored values', () => {
    localStorage.setItem(STORAGE_KEY, 'canvas2d');
    expect(getStoredRendererPreference()).toBeNull();
  });
});

describe('publishRendererBreadcrumbs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets global automation breadcrumbs', () => {
    const win = installBrowserGlobals('');
    publishRendererBreadcrumbs('webgl', 'ci-fallback');
    expect(win.rendererType).toBe('webgl');
    expect(win.usingWebGL).toBe(true);
    expect(win.usingWebGPU).toBe(false);
    expect(win.rendererFallbackReason).toBe('ci-fallback');
  });
});
