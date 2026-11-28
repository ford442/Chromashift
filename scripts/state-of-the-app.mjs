#!/usr/bin/env node
/**
 * Turns a release smoke run into the "State of the App" report (#269): the
 * Markdown the release issues ask for, plus the screenshots it embeds.
 *
 *   npm run release:report -- [--results release-results] [--url <deployed url>]
 *       [--sha <40-hex>] [--stage 2/5] [--build] [--clean]
 *       [--suite "Name|command|results.json|run link"]...
 *       [--manual manual.md] [--known known.md] [--screenshot-base <url prefix>]
 *
 * Reads, from --results (written by `npm run release:smoke`):
 *   results.json          Playwright's JSON report (counts for the release suite)
 *   gate/*.json           one console/network summary per scenario (e2e/release/gate.ts)
 *   screenshots/*.{png,json}  the images and their captions (URL, viewport, renderer, GPU)
 * and writes <results>/report/report.md with its screenshots beside it.
 *
 *   --build   run `npm run build` here and record its exit code, duration and warnings
 *             (with --clean: `rm -rf node_modules dist && npm ci` first, the release gate (a)).
 *             Without it the build section lists dist/ as found, or <results>/build.json.
 *   --suite   a further suite for the Test results table. The file is a Playwright JSON
 *             report or a Vitest `--reporter=json` file; the link is optional.
 *   --screenshot-base  prefix for the image URLs (e.g. the raw.githubusercontent.com path of an
 *             orphan `release-evidence` branch). Default: relative `screenshots/<file>`.
 *
 * Exit code 0 when the report was written. The verdict inside says whether the run is ready.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const values = (n) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));

const results = value('--results') ?? 'release-results';
const reportDir = join(results, 'report');
const stage = value('--stage') ?? '2/5';
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

const git = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

// ── The deployed URL and its live version.json ──────────────────────────────
const url = (value('--url') ?? process.env.RELEASE_URL ?? '').trim() || null;
const base = url ? (url.endsWith('/') ? url : `${url}/`) : null;
const expectedSha = value('--sha') ?? process.env.RELEASE_SHA ?? git('rev-parse', 'HEAD');

async function fetchLiveStamp() {
  if (!base) return { text: null, json: null, error: 'no --url: a local report has no deployed version.json' };
  let last = 'no response';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(`${base}version.json`, { redirect: 'manual' });
      if (res.status === 429) { last = '429'; await new Promise((r) => setTimeout(r, 4000 * (attempt + 1))); continue; }
      if (res.status !== 200) return { text: null, json: null, error: `HTTP ${res.status}` };
      const text = await res.text();
      return { text, json: JSON.parse(text), error: null };
    } catch (e) { last = String(e); }
  }
  return { text: null, json: null, error: last };
}
const live = await fetchLiveStamp();
const localStamp = readJson('dist/version.json');
const stamp = live.json ?? localStamp;
const stampMatches = Boolean(stamp && expectedSha && stamp.sha === expectedSha && stamp.dirty === false);

// ── Fresh production build ──────────────────────────────────────────────────
function runStep(cmd, args) {
  const started = Date.now();
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { status: r.status ?? 1, seconds: (Date.now() - started) / 1000, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

let build = readJson(join(results, 'build.json'));
if (flag('--build')) {
  const steps = [];
  if (flag('--clean')) {
    spawnSync('rm', ['-rf', 'node_modules', 'dist']);
    steps.push(['npm ci', runStep('npm', ['ci', '--no-audit', '--no-fund'])]);
  } else {
    spawnSync('rm', ['-rf', 'dist']);
  }
  if (steps.every(([, s]) => s.status === 0)) steps.push(['npm run build', runStep('npm', ['run', 'build'])]);
  const all = steps.map(([, s]) => s.output).join('\n');
  build = {
    command: flag('--clean') ? 'rm -rf node_modules dist && npm ci && npm run build' : 'rm -rf dist && npm run build',
    clean: flag('--clean'),
    exitCode: steps.find(([, s]) => s.status !== 0)?.[1].status ?? 0,
    seconds: Math.round(steps.reduce((t, [, s]) => t + s.seconds, 0)),
    warnings: all.split('\n').filter((l) => /^\(!\)|\bwarn(ing)?\b/i.test(l)).map((l) => l.trim()).filter(Boolean).slice(0, 15),
    treeClean: git('status', '--porcelain') === '',
  };
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, 'build.json'), `${JSON.stringify(build, null, 2)}\n`);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
const distRows = existsSync('dist')
  ? walk('dist').map((f) => {
      const bytes = readFileSync(f);
      return { file: relative('dist', f), bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
    }).sort((a, b) => b.bytes - a.bytes)
  : [];

// ── Test results ────────────────────────────────────────────────────────────
function countPlaywright(report) {
  const stats = report?.stats;
  if (!stats) return null;
  return { passed: stats.expected ?? 0, failed: (stats.unexpected ?? 0), skipped: stats.skipped ?? 0, flaky: stats.flaky ?? 0 };
}
function countVitest(report) {
  if (!report || typeof report.numPassedTests !== 'number') return null;
  return { passed: report.numPassedTests, failed: report.numFailedTests ?? 0, skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0), flaky: 0 };
}
const counts = (report) => countPlaywright(report) ?? countVitest(report);

const releaseReport = readJson(join(results, 'results.json'));
const suites = [];
const releaseCounts = counts(releaseReport);
if (releaseCounts) {
  suites.push({ name: 'Release smoke (production build)', command: `npm run release:smoke -- ${url ?? ''}`.trim(), ...releaseCounts, link: '' });
}
for (const spec of values('--suite')) {
  const [name, command = '', file = '', link = ''] = spec.split('|');
  const c = counts(readJson(file));
  suites.push({ name, command, ...(c ?? { passed: '?', failed: '?', skipped: '?', flaky: 0 }), link: link || (c ? file : 'no results file') });
}

// ── Console and network, per scenario ───────────────────────────────────────
const gateDir = join(results, 'gate');
const gates = existsSync(gateDir)
  ? readdirSync(gateDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(gateDir, f))).filter((g) => g && g.status !== 'skipped')
  : [];
gates.sort((a, b) => `${a.file}${a.title}${a.project}`.localeCompare(`${b.file}${b.title}${b.project}`));
const sum = (k) => gates.reduce((t, g) => t + g.counts[k], 0);
const gateViolations = gates.reduce((t, g) => t + g.violations.length, 0);
const allowlisted = gates.flatMap((g) => g.allowlisted.map((v) => ({ scenario: `${g.project.replace('release-', '')}: ${g.title}`, ...v })));

// ── Screenshots ─────────────────────────────────────────────────────────────
const shotDir = join(results, 'screenshots');
const shots = existsSync(shotDir)
  ? readdirSync(shotDir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(shotDir, f))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
  : [];
mkdirSync(join(reportDir, 'screenshots'), { recursive: true });
for (const s of shots) if (existsSync(join(shotDir, s.file))) cpSync(join(shotDir, s.file), join(reportDir, 'screenshots', s.file));
const shotBase = value('--screenshot-base') ?? 'screenshots/';

// ── Verdict ─────────────────────────────────────────────────────────────────
const failures = [];
if (!stamp) failures.push('no version.json to identify the build');
else if (!stampMatches) failures.push(`version.json ${stamp.sha}${stamp.dirty ? ' (dirty)' : ''} does not match the expected clean ${expectedSha}`);
if (live.error && base) failures.push(`live version.json unreadable: ${live.error}`);
for (const s of suites) if (s.failed !== 0) failures.push(`${s.name}: ${s.failed} failed`);
if (suites.length === 0) failures.push('no test results found');
if (gateViolations > 0) failures.push(`${gateViolations} unallowlisted console/network problem(s)`);
if (build && build.exitCode !== 0) failures.push('the production build failed');
if (!base) failures.push('this run was not against a deployed URL');
if (shots.length === 0) failures.push('no screenshots');

// ── Render ──────────────────────────────────────────────────────────────────
const fmt = (n) => n.toLocaleString('en-US');
const cell = (n, allowed) => `${n}${allowed ? ` (+${allowed} allowlisted)` : ''}`;
const L = [];
L.push(`## State of the App — Release ${stage}`);
L.push(`- Date (UTC): ${new Date().toISOString()}`);
L.push(`- Commit SHA (full 40 chars): ${stamp?.sha ?? expectedSha ?? 'unknown'}`);
L.push(`- Deployed URL: ${url ?? '(none — local run)'}`);
L.push(`- Live \`version.json\` (paste it) — matches the SHA above, \`dirty: false\`: ${stampMatches ? 'yes' : 'no'}`);
L.push('');
L.push('```json');
L.push(live.text?.trim() ?? (stamp ? `${JSON.stringify(stamp, null, 2)}  // local dist/version.json, not a deployed copy` : `// unavailable: ${live.error}`));
L.push('```');
L.push('');
L.push('### Fresh production build');
if (build) {
  L.push(`- Command: \`${build.command}\``);
  L.push(`- Clean checkout: ${build.clean ? `yes (\`node_modules\` and \`dist\` removed first${build.treeClean ? '; working tree clean' : '; **working tree NOT clean**'})` : 'no — `dist` removed only; not the release gate (a) run'}`);
  L.push(`- Exit code: ${build.exitCode}`);
  L.push(`- Duration: ${build.seconds} s`);
  L.push(`- Warnings: ${build.warnings.length ? '' : 'none'}`);
  for (const w of build.warnings) L.push(`  - ${w}`);
} else {
  L.push('- Not run by this report (`--build`); `dist/` below is whatever was on disk.');
}
L.push('');
L.push('| file | bytes | gzip bytes |');
L.push('|---|---:|---:|');
for (const r of distRows) L.push(`| \`${r.file}\` | ${fmt(r.bytes)} | ${fmt(r.gzip)} |`);
if (distRows.length === 0) L.push('| (no dist/) | | |');
L.push('');
L.push('### Test results');
L.push('| Suite | Command | Passed | Failed | Skipped | Run link or log |');
L.push('|---|---|---:|---:|---:|---|');
for (const s of suites) L.push(`| ${s.name} | \`${s.command}\` | ${s.passed} | ${s.failed} | ${s.skipped}${s.flaky ? ` (${s.flaky} flaky, passed on retry)` : ''} | ${s.link || '—'} |`);
L.push('');
L.push(`### Console and network (against ${base ? 'the deployed URL' : 'a local `vite preview` — **not** the deployed URL'})`);
L.push('| Scenario | Console errors | Warnings | Page errors | Failed requests | HTTP >= 400 / unexpected redirects |');
L.push('|---|---:|---:|---:|---:|---:|');
for (const g of gates) {
  const allowed = (kind) => g.allowlisted.filter((v) => v.kind === kind).length;
  L.push(`| ${g.project.replace('release-', '')}: ${g.file.replace('.spec.ts', '')} › ${g.title} | ${cell(g.counts.consoleErrors, allowed('console-error'))} | ${g.counts.warnings} | ${cell(g.counts.pageErrors, allowed('page-error'))} | ${cell(g.counts.failedRequests, allowed('request-failed'))} | ${cell(g.counts.httpErrors + g.counts.redirects, allowed('http-error') + allowed('redirect'))} |`);
}
L.push(`| **Total (${gates.length} scenarios)** | **${sum('consoleErrors')}** | **${sum('warnings')}** | **${sum('pageErrors')}** | **${sum('failedRequests')}** | **${sum('httpErrors') + sum('redirects')}** |`);
L.push('');
if (allowlisted.length > 0) {
  L.push('Allowlisted on purpose (each scenario provokes it itself):');
  for (const a of allowlisted.slice(0, 40)) L.push(`- ${a.scenario} — \`${a.kind}\`: ${a.allowedBy}`);
  L.push('');
}
L.push('### Screenshots of the live app');
if (shots.length === 0) L.push('_None captured._');
for (const s of shots) {
  L.push(`![${s.name}](${shotBase}${s.file})`);
  L.push(`*${s.name}: ${s.url} · ${s.viewport} · ${s.renderer} · ${s.browser} · ${s.gpu}${s.note ? ` — ${s.note}` : ''}*`);
  L.push('');
}
L.push('### Known issues and deviations');
const known = value('--known') && existsSync(value('--known')) ? readFileSync(value('--known'), 'utf8').trim() : '';
const manual = value('--manual') && existsSync(value('--manual')) ? readFileSync(value('--manual'), 'utf8').trim() : '';
L.push(known || '- None recorded.');
if (manual) { L.push(''); L.push('**Manual results (not automatable: WebXR, a real camera, …)**'); L.push(manual); }
L.push('');
L.push(`### Verdict: ${failures.length === 0 ? 'ready' : 'not ready'} for the next stage`);
for (const f of failures) L.push(`- ${f}`);
if (failures.length === 0) L.push('- Every suite passed, the console/network gate caught nothing, and the live `version.json` is the expected clean commit.');
L.push('');

mkdirSync(reportDir, { recursive: true });
const out = join(reportDir, 'report.md');
writeFileSync(out, L.join('\n'));
console.log(`state-of-the-app — wrote ${out} (${shots.length} screenshots; verdict: ${failures.length === 0 ? 'ready' : 'not ready'})`);
