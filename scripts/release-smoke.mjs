#!/usr/bin/env node
/**
 * The release smoke suite against any base URL (#269).
 *
 *   npm run release:smoke -- [<base-url>] [options] [-- <playwright args>]
 *
 *   <base-url>        `vite preview` over dist/ when omitted (build first), or a
 *                     deployed site, e.g. https://test.1ink.us/chromashift-staging/.
 *                     No server is started for a remote URL.
 *   --sha <40-hex>    commit the live version.json must report. Default: dist/version.json
 *                     for a local run, else `git rev-parse HEAD`. --no-sha skips the check.

 *   --allow-dirty     accept a version.json with `dirty: true` (a local build of a working
 *                     tree; never for a release or staging run)
 *   --stub-corpus     answer the remote corpus images locally (the PR job; a deployed
 *                     run exercises the real corpus host)
 *   --project <name>  release-webgpu | release-webgl | release-upscale (repeatable;
 *                     default: webgpu + webgl, i.e. everything but the slow upscalers)
 *   --out <dir>       results directory (default release-results/)
 *   --report          write the State of the App report from the results afterwards
 *
 * Exits non-zero if any scenario fails, including any console error, page error,
 * failed request, HTTP >= 400 or redirect that a scenario did not allowlist.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

const argv = process.argv.slice(2);
const dashDash = argv.indexOf('--');
const own = dashDash === -1 ? argv : argv.slice(0, dashDash);
const passthrough = dashDash === -1 ? [] : argv.slice(dashDash + 1);

const flag = (name) => own.includes(name);
const value = (name) => {
  const i = own.indexOf(name);
  return i >= 0 ? own[i + 1] : undefined;
};
const values = (name) => own.flatMap((a, i) => (a === name ? [own[i + 1]] : []));

const url = own.find((a) => /^https?:\/\//.test(a));
const out = value('--out') ?? 'release-results';
const projects = values('--project');

function resolveSha() {
  if (flag('--no-sha')) return undefined;
  if (value('--sha')) return value('--sha');
  if (!url && existsSync('dist/version.json')) return JSON.parse(readFileSync('dist/version.json', 'utf8')).sha;
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return git.status === 0 ? git.stdout.trim() : undefined;
}

if (!url && !existsSync('dist/index.html')) {
  console.error('release:smoke — no dist/; run `npm run build` first, or pass a base URL.');
  process.exit(2);
}
const sha = resolveSha();
if (!sha && !flag('--no-sha')) console.warn('release:smoke — no expected SHA known; version.json is checked for shape only.');

rmSync(out, { recursive: true, force: true });

const env = {
  ...process.env,
  RELEASE_OUT: out,
  ...(url ? { RELEASE_URL: url } : {}),
  ...(sha ? { RELEASE_SHA: sha } : {}),
  ...(flag('--stub-corpus') ? { RELEASE_STUB_CORPUS: '1' } : {}),
  ...(flag('--allow-dirty') ? { RELEASE_ALLOW_DIRTY: '1' } : {}),
};
const selected = (projects.length > 0 ? projects : ['release-webgpu', 'release-webgl']).flatMap((p) => ['--project', p]);

console.log(`release:smoke — ${url ?? 'vite preview over dist/'}${sha ? ` expecting ${sha}` : ''}`);
const run = spawnSync('npx', ['playwright', 'test', '--config=playwright.release.config.ts', ...passthrough, ...selected], {
  stdio: 'inherit',
  env,
});
let status = run.status ?? 1;

if (flag('--report')) {
  const report = spawnSync('node', ['scripts/state-of-the-app.mjs', '--results', out, ...(url ? ['--url', url] : [])], {
    stdio: 'inherit',
    env,
  });
  if (report.status !== 0) status = status || report.status || 1;
}
process.exit(status);
