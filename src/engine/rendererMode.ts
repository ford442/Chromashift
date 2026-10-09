import type { RendererBackend } from './RendererTypes';

const STORAGE_KEY = 'chromashift.renderer';

/**
 * Explicit WebGL2 selection (URL, Renderer panel, stored preference).
 *
 * This is **not** automatic `WebGPU → WebGL` fallback. A failed WebGPU boot
 * still hard-fails with the probe overlay; `window.usingWebGL` stays false
 * until a *new* navigation starts an explicit WebGL diagnostic session.
 *
 * Set to `false` to ignore `?renderer=webgl` again (kill switch).
 *
 * See `docs/webgl-fallback.md`.
 */
export const WEBGL_BACKEND_ENABLED = true;

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
    // An explicit `renderer=` wins over the bare flags, so `?renderer=webgpu`
    // is never rewritten by a leftover `webgl2` parameter.
    if (explicit === 'webgl') return 'webgl';
    if (explicit === 'webgpu') return 'webgpu';
    if (params.has('webgl') || webgl2QueryOptIn(params)) return 'webgl';
    if (params.has('webgpu')) return 'webgpu';
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
      '[Chromashift:GPU] WebGL2 diagnostic backend is disabled; '
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
  if (backend === 'webgl' && !WEBGL_BACKEND_ENABLED) {
    console.warn(
      '[Chromashift:GPU] Ignoring WebGL2 renderer switch — the diagnostic backend is disabled. '
      + 'See docs/webgl-fallback.md.',
    );
    return;
  }

  setStoredRendererPreference(backend);
  const url = new URL(window.location.href);
  url.searchParams.set('renderer', backend);
  url.searchParams.delete('webgl');
  url.searchParams.delete('webgl2');
  url.searchParams.delete('webgpu');
  window.location.assign(url.toString());
}

/**
 * `?webgl2=1` (also `true`, or a bare `?webgl2`) opts into the diagnostic
 * backend. `0` / `false` do not — a WebGL2 session never starts on its own.
 */
export function webgl2QueryOptIn(params: URLSearchParams): boolean {
  if (!params.has('webgl2')) return false;
  const value = (params.get('webgl2') ?? '').toLowerCase();
  return value === '' || value === '1' || value === 'true';
}

/** Navigate into an explicit WebGL diagnostic / XR / screenshot session. */
export function openWebGlDiagnosticSession(): void {
  switchRendererPreference('webgl');
}
