#!/usr/bin/env node
/**
 * Post-build guard: main bundle must stay free of lazy upscaler deps, and ORT
 * wasm must not be emitted into dist/ (runtime loads from VITE_NUNIF_ORT_WASM_BASE).
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

for (const chunk of indexChunks) {
  const text = await readFile(chunk, 'utf8');
  if (/ort-wasm/i.test(text)) {
    fail(`${chunk} references ort-wasm — lazy upscaler deps must stay out of the main bundle`);
  }
  if (/\btfjs\b|@tensorflow\/tfjs/i.test(text)) {
    fail(`${chunk} references tfjs — lazy upscaler deps must stay out of the main bundle`);
  }
}

console.log('check:dist — OK (no ort-wasm*.wasm in dist; main chunk clean)');
