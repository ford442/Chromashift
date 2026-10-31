#!/usr/bin/env node
/**
 * Post-build guard: main bundle must stay free of lazy upscaler deps, and ORT
 * wasm must not be emitted into dist/ (runtime loads from VITE_NUNIF_ORT_WASM_BASE).
 * Nothing of the Node-only headless renderer (src/headless/) may reach dist/ at all.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = 'dist';
const ORT_WASM_BUDGET_BYTES = 100 * 1024;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else {
      files.push(path);
    }
  }
  return files;
}

function fail(message) {
  console.error(`check:dist — ${message}`);
  process.exit(1);
}

const distStat = await stat(DIST).catch(() => null);
if (!distStat?.isDirectory()) {
  fail(`missing ${DIST}/ — run npm run build first`);
}

const allFiles = await walk(DIST);
const ortWasmFiles = allFiles.filter((f) => /ort-wasm.*\.wasm$/i.test(f));

if (ortWasmFiles.length > 0) {
  const sizes = await Promise.all(
    ortWasmFiles.map(async (f) => {
      const s = await stat(f);
      return `${f} (${(s.size / 1024 / 1024).toFixed(1)} MB)`;
    }),
  );
  const total = ortWasmFiles.reduce(async (accP, f) => {
    const acc = await accP;
    const s = await stat(f);
    return acc + s.size;
  }, Promise.resolve(0));
  const totalBytes = await total;
  if (totalBytes > ORT_WASM_BUDGET_BYTES) {
    fail(
      `found bundled ORT wasm (budget ${ORT_WASM_BUDGET_BYTES} B):\n  ${sizes.join('\n  ')}`,
    );
  }
}

const indexChunks = allFiles.filter((f) => /[/\\]index-[^/\\]+\.js$/.test(f));
if (indexChunks.length === 0) {
  fail('no dist/assets/index-*.js entry chunk found');
}

const indexHtml = await readFile(join(DIST, 'index.html'), 'utf8').catch(() => null);
const entryMatch = indexHtml?.match(/src="\.\/assets\/(index-[^"]+\.js)"/);
const entryChunkPath = entryMatch ? join(DIST, 'assets', entryMatch[1]) : indexChunks[0];

if (!indexChunks.some((chunk) => chunk === entryChunkPath)) {
  fail(`entry chunk ${entryMatch?.[1] ?? 'unknown'} not found under dist/assets/`);
}

const analysisWorkerChunks = allFiles.filter((f) => /[/\\]analysis\.worker-[^/\\]+\.js$/.test(f));
if (analysisWorkerChunks.length === 0) {
  fail('no dist/assets/analysis.worker-*.js chunk found — the gpu-chores CPU-lane worker must be its own lazy-loaded chunk');
}

const motionWorkerChunks = allFiles.filter((f) => /[/\\]motion\.worker-[^/\\]+\.js$/.test(f));
if (motionWorkerChunks.length === 0) {
  fail('no dist/assets/motion.worker-*.js chunk found — the motion-field CPU lane must be its own lazy-loaded chunk');
}

for (const chunk of [entryChunkPath]) {
  const text = await readFile(chunk, 'utf8');
  if (/ort-wasm/i.test(text)) {
    fail(`${chunk} references ort-wasm — lazy upscaler deps must stay out of the main bundle`);
  }
  if (/\btfjs\b|@tensorflow\/tfjs/i.test(text)) {
    fail(`${chunk} references tfjs — lazy upscaler deps must stay out of the main bundle`);
  }
  if (/\bmediabunny\b/i.test(text)) {
    fail(`${chunk} references mediabunny — export muxer must stay out of the main bundle`);
  }
  if (/analysis\.worker:/.test(text)) {
    fail(`${chunk} inlines the analysis worker's own code — it must load lazily as a separate chunk`);
  }
  if (/motion\.worker:/.test(text)) {
    fail(`${chunk} inlines the motion worker's own code — it must load lazily as a separate chunk`);
  }
}

// The headless renderer (src/headless/, docs/HEADLESS.md) runs under Node:
// Dawn's bindings, sharp, the golden tooling and the CLI must never be bundled,
// and no chunk may import a `node:` built-in. Every chunk, not just the entry.
const HEADLESS_LEAKS = [
  [/(?:\bfrom|\bimport\(|\brequire\()\s*["'](?:webgpu|sharp|pngjs|pixelmatch)["']/, 'imports a Node-only headless dependency'],
  [/(?:\bfrom|\bimport\(|\brequire\()\s*["']node:/, 'imports a node: built-in'],
  [/dawn\.node|@img\/sharp/, 'carries Dawn\'s or sharp\'s native loader'],
  [/HeadlessSurface|src\/headless\//, 'carries headless renderer code'],
];
for (const file of allFiles.filter((f) => /\.m?js$/.test(f))) {
  const text = await readFile(file, 'utf8');
  for (const [pattern, what] of HEADLESS_LEAKS) {
    if (pattern.test(text)) fail(`${file} ${what} — src/headless/ is Node-only and must stay out of dist/`);
  }
}

console.log(
  'check:dist — OK (no ort-wasm*.wasm in dist; main chunk clean; '
  + 'analysis and motion workers are their own chunks; no headless code)',
);
