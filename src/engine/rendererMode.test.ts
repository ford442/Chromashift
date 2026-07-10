import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRendererPreference,
  getStoredRendererPreference,
  publishRendererBreadcrumbs,
  setStoredRendererPreference,
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

  it('prefers explicit ?renderer=webgl', () => {
    installBrowserGlobals('?renderer=webgl');
    expect(getRendererPreference()).toBe('webgl');
  });

  it('prefers explicit ?renderer=webgpu', () => {
    installBrowserGlobals('?renderer=webgpu');
    expect(getRendererPreference()).toBe('webgpu');
  });

  it('treats ?webgl flag as webgl', () => {
    installBrowserGlobals('?webgl');
    expect(getRendererPreference()).toBe('webgl');
  });

  it('falls back to localStorage then webgpu default', () => {
    installBrowserGlobals('');
    expect(getRendererPreference()).toBe('webgpu');

    setStoredRendererPreference('webgl');
    expect(getRendererPreference()).toBe('webgl');
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
