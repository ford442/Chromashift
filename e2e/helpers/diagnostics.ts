/**
 * Typed access to the app's `window.*` breadcrumbs from Playwright.
 *
 * The schema is `ChromashiftDiagnostics` (src/engine/diagnostics.ts), whose
 * `Window` augmentation also types every bare `window.passGraphExecuting` read
 * inside a spec's `page.evaluate` — `tsconfig.e2e.json` type-checks `e2e/`, so
 * renaming a breadcrumb breaks `tsc -b`, not a CI run.
 */

import type { Page } from '@playwright/test';
import type { ChromashiftDiagnostics, DiagnosticKey } from '../../src/engine/diagnostics';

export type { ChromashiftDiagnostics, DiagnosticKey };

/** One breadcrumb's current value; `undefined` until the app publishes it. */
export function readDiagnostic<K extends DiagnosticKey>(
  page: Page,
  key: K,
): Promise<ChromashiftDiagnostics[K] | undefined> {
  return page.evaluate((k) => window[k], key) as Promise<ChromashiftDiagnostics[K] | undefined>;
}

/** Wait until a breadcrumb holds `expected` (compared with `===` in the page). */
export async function waitForDiagnostic<K extends DiagnosticKey>(
  page: Page,
  key: K,
  expected: ChromashiftDiagnostics[K],
  timeout = 30_000,
): Promise<void> {
  await page.waitForFunction(([k, v]) => window[k] === v, [key, expected] as const, { timeout });
}
