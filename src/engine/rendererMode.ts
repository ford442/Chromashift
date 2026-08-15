import type { RendererBackend } from './RendererTypes';

const STORAGE_KEY = 'chromashift.renderer';

/**
 * WebGL2 selection is disabled for this development phase: WebGPU is
 * required, and a failed WebGPU boot must hard-fail rather than slide to a
 * different renderer. `?renderer=webgl`, `?webgl`, the NUNIF Renderer
 * control, and a stored `chromashift.renderer = webgl` are all ignored while
 * this is false — they must never rescue a failed WebGPU boot.
 *
 * Flipping this back on is the later fallback wave; see
 * `docs/webgl-fallback.md`.
 */
export const WEBGL_BACKEND_ENABLED = false;

/**
 * True when the user asked for WebGL but the request was ignored, so the UI
 * can say so instead of silently showing a WebGPU canvas.
 */
export function isWebGlRequestIgnored(): boolean {
  if (WEBGL_BACKEND_ENABLED) return false;
  return readRequestedBackend() === 'webgl';
}

/** The backend the user actually asked for, before the phase gate. */
export function readRequestedBackend(): RendererBackend | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const explicit = params.get('renderer')?.toLowerCase();
    if (explicit === 'webgl' || params.has('webgl')) return 'webgl';
    if (explicit === 'webgpu' || params.has('webgpu')) return 'webgpu';
  } catch {
    // Malformed URL — fall through to storage.
  }
  return getStoredRendererPreference();
}

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
  const requested = readRequestedBackend();

  if (requested === 'webgl' && !WEBGL_BACKEND_ENABLED) {
    console.warn(
      '[Chromashift:GPU] WebGL2 backend is disabled for this development phase; '
      + 'ignoring the request and requiring WebGPU. A WebGPU failure will hard-fail '
      + 'rather than fall back. See docs/webgl-fallback.md.',
    );
    return 'webgpu';
  }

  return requested ?? 'webgpu';
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

/**
 * Breadcrumbs for a hard-failed WebGPU boot. `usingWebGL` is pinned false:
 * no renderer started, and automation must not read the failure as a
 * successful fallback.
 */
export function publishRendererBootFailure(reason: string): void {
  const target = window as Window & {
    rendererType?: RendererBackend | null;
    usingWebGPU?: boolean;
    usingWebGL?: boolean;
    rendererFallbackReason?: string | null;
  };
  target.rendererType = null;
  target.usingWebGPU = false;
  target.usingWebGL = false;
  target.rendererFallbackReason = reason;
}

export function switchRendererPreference(backend: RendererBackend): void {
  // Defence in depth: even if a caller reaches this with 'webgl', refuse to
  // persist it. A stored preference must never rescue a failed WebGPU boot.
  if (backend === 'webgl' && !WEBGL_BACKEND_ENABLED) {
    console.warn(
      '[Chromashift:GPU] Ignoring WebGL2 renderer switch — the backend is disabled '
      + 'for this development phase. See docs/webgl-fallback.md.',
    );
    return;
  }

  setStoredRendererPreference(backend);
  const url = new URL(window.location.href);
  url.searchParams.set('renderer', backend);
  window.location.assign(url.toString());
}
