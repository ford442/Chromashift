import { test } from '@playwright/test';

/**
 * WebGL2 selection is disabled for this development phase (WebGPU is
 * required, and a failed WebGPU boot hard-fails instead of falling back), so
 * every spec that drives the app with `?renderer=webgl` is pending until the
 * later fallback wave restores the backend.
 *
 * These specs are marked skipped rather than deleted: they are the coverage
 * the fallback wave has to bring back, and a visible skip in the report is
 * the reminder. Set `CHROMASHIFT_E2E_WEBGL=1` to run them locally against a
 * build with `WEBGL_BACKEND_ENABLED` flipped on.
 *
 * See `docs/webgl-fallback.md` and `src/engine/rendererMode.ts`.
 */
export const WEBGL_E2E_ENABLED = process.env.CHROMASHIFT_E2E_WEBGL === '1';

const SKIP_REASON = 'WebGL2 backend is disabled for this development phase '
  + '(WebGPU required); pending the later fallback wave. '
  + 'Set CHROMASHIFT_E2E_WEBGL=1 to run.';

/**
 * Call at the top of a `test.describe` body to mark the whole block pending
 * while the WebGL backend is disabled.
 */
export function skipWhileWebGlDisabled(): void {
  test.skip(!WEBGL_E2E_ENABLED, SKIP_REASON);
}
