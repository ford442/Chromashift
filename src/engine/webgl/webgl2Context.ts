import {
  WEBGL2_POWER_PREFERENCE_ATTEMPTS,
  getWebGL2ContextAttributes,
  type RendererCanvasOptions,
} from '../gpu/gpuOptions';

/** Every `getContext('webgl2')` attempt returned null. Never retried by touching WebGPU. */
export class WebGL2UnavailableError extends Error {
  override readonly name = 'WebGL2UnavailableError';
}

/**
 * The canvas's context is lost and not yet restored. Asking `getContext` again
 * cannot help — it returns the same lost context — so recovery waits for
 * `webglcontextrestored` (see {@link watchWebGL2Context}).
 */
export class WebGL2ContextLostError extends Error {
  override readonly name = 'WebGL2ContextLostError';
}

/**
 * The context each canvas was granted. `getContext` is sticky, so a canvas has
 * at most one; remembering it is what lets a re-bootstrap after
 * `webglcontextrestored` (or a React effect re-run) reuse it without a second
 * `getContext` call.
 */
const webgl2Contexts = new WeakMap<HTMLCanvasElement, WebGL2RenderingContext>();

/**
 * The canvas's WebGL2 context: the one it already has, or the first of
 * `WEBGL2_POWER_PREFERENCE_ATTEMPTS` the browser grants. Never calls
 * `requestAdapter` — an explicit WebGL session stays explicit.
 */
export function createWebGL2Context(
  canvas: HTMLCanvasElement,
  options: RendererCanvasOptions,
): WebGL2RenderingContext {
  const existing = webgl2Contexts.get(canvas);
  if (existing) {
    if (existing.isContextLost()) {
      throw new WebGL2ContextLostError('The WebGL2 context is lost and has not been restored yet.');
    }
    return existing;
  }

  for (const [index, powerPreference] of WEBGL2_POWER_PREFERENCE_ATTEMPTS.entries()) {
    const gl = canvas.getContext('webgl2', getWebGL2ContextAttributes(options, powerPreference));
    if (!gl) continue;
    console.info('[Chromashift:GPU] WebGL2 context ready', {
      attempt: index + 1,
      powerPreference: powerPreference ?? '(omitted)',
    });
    webgl2Contexts.set(canvas, gl);
    return gl;
  }

  const tried = WEBGL2_POWER_PREFERENCE_ATTEMPTS.map((p) => p ?? 'no preference').join(', ');
  console.error(`[Chromashift:GPU] getContext('webgl2') returned null for ${tried}`);
  throw new WebGL2UnavailableError(`WebGL2 is not supported in this browser (getContext returned null for ${tried}).`);
}

/**
 * Listen for context loss on a WebGL2 canvas — the twin of
 * `attachDeviceDiagnostics`' `device.lost`. `webglcontextlost` is
 * `preventDefault()`ed, without which the browser never restores the context.
 * Returns the detach.
 */
export function watchWebGL2Context(
  canvas: HTMLCanvasElement,
  handlers: { onLost: () => void; onRestored: () => void },
): () => void {
  const lost = (event: Event) => {
    event.preventDefault();
    console.warn('[Chromashift:GPU] WebGL2 context lost');
    handlers.onLost();
  };
  const restored = () => {
    console.info('[Chromashift:GPU] WebGL2 context restored');
    handlers.onRestored();
  };
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  return () => {
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', restored);
  };
}
