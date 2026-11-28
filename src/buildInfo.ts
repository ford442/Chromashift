/**
 * Build stamp (#268): which commit a running build came from.
 *
 * `vite.config.ts` computes `{ sha, dirty, builtAt }` once per build, inlines it
 * as `__BUILD_INFO__`, and writes the same object to `dist/version.json`. The
 * app publishes it as the `chromashiftBuild` breadcrumb (`window.chromashiftBuild`,
 * declared in `engine/diagnostics.ts`) so the commit of a deployed page can be
 * read from the browser console without fetching anything.
 */

import { publishDiagnostic } from './engine/diagnostics';

export interface BuildInfo {
  /** Full 40-character commit SHA, or `unknown` when the build had no git checkout. */
  sha: string;
  /** True when the working tree differed from `sha` at build time (or is unknown). */
  dirty: boolean;
  /** ISO-8601 UTC timestamp of the build. */
  builtAt: string;
}

declare const __BUILD_INFO__: BuildInfo | undefined;

/** What a build without the Vite `define` (Vitest, a bare `tsc`) reports. */
const UNSTAMPED: BuildInfo = { sha: 'unknown', dirty: true, builtAt: '1970-01-01T00:00:00.000Z' };

export function getBuildInfo(): Readonly<BuildInfo> {
  return typeof __BUILD_INFO__ === 'undefined' ? UNSTAMPED : __BUILD_INFO__;
}

/** Publish the stamp on `window.chromashiftBuild`. Idempotent. */
export function installBuildInfo(): Readonly<BuildInfo> {
  const info = Object.freeze({ ...getBuildInfo() });
  publishDiagnostic('chromashiftBuild', info);
  return info;
}
