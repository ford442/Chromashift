import type { RendererBackend } from './RendererTypes';

const STORAGE_KEY = 'chromashift.renderer';

export function getStoredRendererPreference(): RendererBackend | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'webgl' || value === 'webgpu' ? value : null;
  } catch {
    return null;
  }
}

export function setStoredRendererPreference(backend: RendererBackend): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, backend);
  } catch {
    // Storage can be disabled in hardened test browsers.
  }
}

export function getRendererPreference(): RendererBackend {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get('renderer')?.toLowerCase();
  if (explicit === 'webgl' || params.has('webgl')) return 'webgl';
  if (explicit === 'webgpu' || params.has('webgpu')) return 'webgpu';
  return getStoredRendererPreference() ?? 'webgpu';
}

export function publishRendererBreadcrumbs(
  backend: RendererBackend,
  fallbackReason: string | null = null,
): void {
  const target = window as Window & {
    rendererType?: RendererBackend;
    usingWebGPU?: boolean;
    usingWebGL?: boolean;
    rendererFallbackReason?: string | null;
  };
  target.rendererType = backend;
  target.usingWebGPU = backend === 'webgpu';
  target.usingWebGL = backend === 'webgl';
  target.rendererFallbackReason = fallbackReason;
}

export function switchRendererPreference(backend: RendererBackend): void {
  setStoredRendererPreference(backend);
  const url = new URL(window.location.href);
  url.searchParams.set('renderer', backend);
  window.location.assign(url.toString());
}
