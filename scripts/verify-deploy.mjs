#!/usr/bin/env node
/**
 * Verifies a served copy of dist/ — `vite preview`, staging or production (#268).
 *
 *   node scripts/verify-deploy.mjs <base-url> [--sha <40-char sha>]
 *
 * Every file in the local dist/ is requested from <base-url> and must answer 200
 * with a MIME type its extension needs (dist/ is what the built app can
 * reference: entry, chunks, worker chunks, the WASM engine, images.json).
 * The root URL (no index.html) must serve the app, not a directory listing, and
 * must send the cross-origin isolation headers. /version.json must be the
 * `--sha` commit with `dirty: false`, and byte-equal to the local dist/ copy
 * unless --sha is the only thing being checked (--no-compare).
 *
 * Exits 1 on any failure; prints one line per check.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const DIST = 'dist';
const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a));
const shaIndex = args.indexOf('--sha');
const expectedSha = shaIndex >= 0 ? args[shaIndex + 1] : null;
if (!base) {
  console.error('usage: verify-deploy.mjs <base-url> [--sha <sha>]');
  process.exit(2);
}
const root = base.endsWith('/') ? base : `${base}/`;

const MIME = {
  '.html': [/^text\/html\b/],
  '.js': [/^(text|application)\/(x-)?javascript\b/],
  '.mjs': [/^(text|application)\/(x-)?javascript\b/],
  '.css': [/^text\/css\b/],
  '.json': [/^application\/json\b/],
  '.wasm': [/^application\/wasm\b/],
  '.svg': [/^image\/svg\+xml\b/],
  '.png': [/^image\/png\b/],
};
// Files Apache refuses to serve on purpose.
const NOT_SERVED = new Set(['.htaccess']);

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return files.flat();
}

/** GET with a short retry: the host rate-limits (429) bursts. */
async function get(url) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, { redirect: 'manual', headers: { 'cache-control': 'no-cache' } });
    if (res.status !== 429 || attempt >= 4) return res;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

function isolationHeaders(res, what) {
  const coop = res.headers.get('cross-origin-opener-policy');
  const coep = res.headers.get('cross-origin-embedder-policy');
  check(coop === 'same-origin', `${what}: Cross-Origin-Opener-Policy`, String(coop));
  check(coep === 'require-corp', `${what}: Cross-Origin-Embedder-Policy`, String(coep));
}

// Root URL: the app, not "Index of /…".
{
  const res = await get(root);
  const body = await res.text();
  check(res.status === 200, `GET ${root}`, `HTTP ${res.status}`);
  check(!/Index of /.test(body) && body.includes('id="root"'), 'root URL serves the app, not a listing');
  isolationHeaders(res, 'root');
}

// Every file of the build.
const files = (await walk(DIST)).map((f) => relative(DIST, f).split(sep).join('/')).sort();
let served = 0;
for (const file of files) {
  if (NOT_SERVED.has(file)) continue;
  const ext = file.slice(file.lastIndexOf('.'));
  const res = await get(new URL(file, root));
  const type = res.headers.get('content-type') ?? '';
  const patterns = MIME[ext];
  const mimeOk = patterns ? patterns.some((p) => p.test(type)) : true;
  check(res.status === 200 && mimeOk, file, `HTTP ${res.status}, ${type || 'no content-type'}`);
  if (res.status === 200 && mimeOk) served += 1;
  if (file.startsWith('assets/') && file.includes('worker')) isolationHeaders(res, file);
}
console.log(`${served}/${files.length - NOT_SERVED.size} build files served with the right type`);

// Build stamp.
{
  const res = await get(new URL('version.json', root));
  const live = await res.json().catch(() => null);
  console.log(`live version.json: ${JSON.stringify(live)}`);
  check(live !== null && live.dirty === false, 'version.json dirty: false');
  if (expectedSha) check(live?.sha === expectedSha, `version.json sha is ${expectedSha}`, String(live?.sha));
  const local = JSON.parse(await readFile(join(DIST, 'version.json'), 'utf8'));
  check(live?.sha === local.sha && live?.builtAt === local.builtAt, 'live version.json equals the local dist/ build');
}

if (failures > 0) {
  console.error(`verify-deploy: ${failures} check(s) failed against ${root}`);
  process.exit(1);
}
console.log(`verify-deploy: all checks passed against ${root}`);
