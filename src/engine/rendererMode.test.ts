import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRendererPreference,
  getStoredRendererPreference,
  isWebGlRequestIgnored,
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
    location: { search, href: `http://localhost:5173/${search}` },
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

  it('ignores explicit ?renderer=webgl while the WebGL backend is disabled', () => {
    installBrowserGlobals('?renderer=webgl');
    expect(getRendererPreference()).toBe('webgpu');
    // The request is still readable, so the UI can say it was ignored.
    expect(readRequestedBackend()).toBe('webgl');
    expect(isWebGlRequestIgnored()).toBe(true);
  });

  it('prefers explicit ?renderer=webgpu', () => {
    installBrowserGlobals('?renderer=webgpu');
    expect(getRendererPreference()).toBe('webgpu');
    expect(isWebGlRequestIgnored()).toBe(false);
  });

  it('ignores the bare ?webgl flag', () => {
    installBrowserGlobals('?webgl');
    expect(getRendererPreference()).toBe('webgpu');
    expect(readRequestedBackend()).toBe('webgl');
  });

  it('a stored webgl preference cannot rescue a failed WebGPU boot', () => {
    installBrowserGlobals('');
    expect(getRendererPreference()).toBe('webgpu');

    // switchRendererPreference refuses to persist it in the first place...
    switchRendererPreference('webgl');
    expect(getStoredRendererPreference()).toBeNull();

    // ...and even a pre-existing stored value is ignored.
    setStoredRendererPreference('webgl');
    expect(getRendererPreference()).toBe('webgpu');
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
