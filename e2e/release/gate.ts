/**
 * The release suite's console + network gate (#269).
 *
 * Every release scenario runs behind it: any console error, uncaught page error,
 * failed request, HTTP status >= 400 or redirect (3xx other than a 304 cache
 * revalidation) fails the test — from the page, its workers and any further tab
 * the scenario opens. A scenario that provokes one on purpose says so with
 * `gate.allow({ kind, match, reason })`; every entry carries the reason it exists
 * and is reported (used or not) in the run's gate summary, which
 * `scripts/state-of-the-app.mjs` turns into the report's console/network table.
 *
 * Why redirects fail by themselves: the live server answers a missing file with a
 * 302 to an off-site 404 page (#269), so "status >= 400" alone never sees a
 * missing asset.
 *
 * A file the app asked for by extension (.js, .css, .wasm, …) that comes back as HTML
 * is a `bad-mime` violation: a static server that falls back to `index.html` (`vite
 * preview` does) answers a *missing* chunk with a 200, and the app then quietly
 * degrades — a missing render worker used to leave the renderer on the main thread with
 * a clean console and a passing suite.
 *
 * `net::ERR_ABORTED` is not a failed request: it is the browser reporting that
 * the app cancelled a request itself (an image load superseded by the next one,
 * a media element re-seeking). It is counted in the summary, not failed on.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  test as base,
  expect,
  type ConsoleMessage,
  type Page,
  type Worker,
} from '@playwright/test';

export type ViolationKind = 'console-error' | 'page-error' | 'request-failed' | 'http-error' | 'redirect' | 'bad-mime';

export interface Allowance {
  kind: ViolationKind;
  /** Matched against the message text, or the URL (plus status) for network kinds. */
  match: RegExp;
  /** Why this scenario is allowed to produce it. Required: an allowlist without reasons is a mute button. */
  reason: string;
}

export interface Violation {
  kind: ViolationKind;
  text: string;
  allowedBy?: string;
}

export type Renderer = 'webgpu' | 'webgl';

/** What a file's extension promises about its Content-Type. */
const MIME_BY_EXTENSION: Record<string, RegExp> = {
  js: /javascript/i,
  mjs: /javascript/i,
  css: /^text\/css/i,
  wasm: /^application\/wasm/i,
  json: /json/i,
  svg: /^image\/svg/i,
  png: /^image\/png/i,
  webm: /^video\/webm/i,
};

function mimeProblem(url: string, contentType: string | undefined): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  const expected = extension ? MIME_BY_EXTENSION[extension] : undefined;
  if (!expected || !contentType) return null;
  // A file that is served as HTML where something else was promised is the fallback page.
  return expected.test(contentType) ? null : `${url} is ${contentType}, not what .${extension} promises`;
}

export const RESULTS_DIR = process.env.RELEASE_OUT ?? 'release-results';

/** Slug for file names: the project and the full test title. */
function slug(...parts: string[]): string {
  return parts.join('--').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120);
}

interface GateApi {
  allow(allowance: Allowance): void;
  violations(): Violation[];
}

interface GateSummary {
  title: string;
  project: string;
  file: string;
  status: string;
  url: string;
  counts: {
    consoleErrors: number;
    warnings: number;
    pageErrors: number;
    failedRequests: number;
    httpErrors: number;
    redirects: number;
    aborted: number;
  };
  allowlisted: Violation[];
  violations: Violation[];
  warnings: string[];
  allowances: { kind: ViolationKind; match: string; reason: string; used: boolean }[];
}

function describeConsole(msg: ConsoleMessage): string {
  const where = msg.location().url;
  return `${msg.text()}${where ? ` (${where})` : ''}`;
}

export const test = base.extend<{ renderer: Renderer; gate: GateApi }>({
  renderer: ['webgpu', { option: true }],

  gate: [
    async ({ context, page }, use, testInfo) => {
      const found: Violation[] = [];
      const warnings: string[] = [];
      const allowances: (Allowance & { used: boolean })[] = [];
      let aborted = 0;

      const note = (kind: ViolationKind, text: string) => found.push({ kind, text });

      const watchWorker = (worker: Worker) => {
        worker.on('console', (msg) => {
          if (msg.type() === 'error') note('console-error', `[worker ${worker.url()}] ${describeConsole(msg)}`);
          else if (msg.type() === 'warning') warnings.push(`[worker] ${msg.text()}`);
        });
      };

      const watchPage = (target: Page) => {
        target.on('console', (msg) => {
          if (msg.type() === 'error') note('console-error', describeConsole(msg));
          else if (msg.type() === 'warning') warnings.push(msg.text());
        });
        target.on('pageerror', (error) => note('page-error', error.stack ?? error.message));
        target.on('requestfailed', (request) => {
          const reason = request.failure()?.errorText ?? 'unknown';
          if (reason === 'net::ERR_ABORTED') {
            aborted += 1;
            return;
          }
          note('request-failed', `${request.method()} ${request.url()} — ${reason}`);
        });
        target.on('response', (response) => {
          const status = response.status();
          const url = response.url();
          if (url.startsWith('data:') || url.startsWith('blob:')) return;
          if (status < 300) {
            const problem = mimeProblem(url, response.headers()['content-type']);
            if (problem) note('bad-mime', problem);
          }
          if (status >= 400) note('http-error', `${status} ${url}`);
          else if (status >= 300 && status !== 304) {
            note('redirect', `${status} ${url} → ${response.headers().location ?? '(no location)'}`);
          }
        });
        target.on('worker', watchWorker);
      };

      const adopt = (target: Page) => watchPage(target);
      watchPage(page);
      context.on('page', adopt);

      const classify = (): Violation[] =>
        found.map((violation) => {
          const allowance = allowances.find((a) => a.kind === violation.kind && a.match.test(violation.text));
          if (!allowance) return violation;
          allowance.used = true;
          return { ...violation, allowedBy: allowance.reason };
        });

      await use({
        allow(allowance) {
          if (!allowance.reason.trim()) throw new Error('gate.allow() needs a reason');
          allowances.push({ ...allowance, used: false });
        },
        violations: () => classify().filter((v) => !v.allowedBy),
      });

      context.off('page', adopt);
      const classified = classify();
      const unallowed = classified.filter((v) => !v.allowedBy);
      const count = (kind: ViolationKind) => unallowed.filter((v) => v.kind === kind).length;

      const summary: GateSummary = {
        title: testInfo.title,
        project: testInfo.project.name,
        file: testInfo.file.replace(/^.*[\\/]e2e[\\/]release[\\/]/, ''),
        status: testInfo.status ?? 'unknown',
        url: page.url(),
        counts: {
          consoleErrors: count('console-error'),
          warnings: warnings.length,
          pageErrors: count('page-error'),
          failedRequests: count('request-failed'),
          httpErrors: count('http-error'),
          redirects: count('redirect'),
          aborted,
        },
        allowlisted: classified.filter((v) => v.allowedBy),
        violations: unallowed,
        warnings: [...new Set(warnings)].slice(0, 25),
        allowances: allowances.map((a) => ({ kind: a.kind, match: a.match.source, reason: a.reason, used: a.used })),
      };
      const dir = join(RESULTS_DIR, 'gate');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${slug(testInfo.project.name, testInfo.titlePath.slice(1).join(' '))}.json`), `${JSON.stringify(summary, null, 2)}\n`);

      if (unallowed.length > 0) {
        const lines = unallowed.slice(0, 20).map((v) => `  [${v.kind}] ${v.text}`);
        throw new Error(`The console/network gate caught ${unallowed.length} problem(s):\n${lines.join('\n')}`);
      }
    },
    { auto: true },
  ],
});

export { expect };
