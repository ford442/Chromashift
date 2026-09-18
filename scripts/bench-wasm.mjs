#!/usr/bin/env node
/**
 * Headless perf gate for the C++/WASM engine.
 *
 * Loads public/chromashift_engine.{js,wasm}, runs every bulk kernel over a
 * deterministic 4K golden image and prints the throughput of each. With
 * `--assert` (how CI runs it) it exits non-zero when a kernel falls below its
 * floor in public/wasm-benchmark-core.mjs — so silently losing the SIMD128 path
 * fails the `wasm` job instead of quietly un-accelerating the CPU fallback lane.
 *
 *   npm run bench:wasm            # report only
 *   npm run bench:wasm -- --assert
 *
 * The engine is built with `-s ENVIRONMENT=web,worker`, so the glue has no
 * Node file loader; passing `wasmBinary` skips its fetch entirely and the same
 * artifact CI ships is what gets measured.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  BYTE_LENGTH,
  HEIGHT,
  WIDTH,
  buildGoldenImage,
  runBenchmark,
} from '../public/wasm-benchmark-core.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const gluePath = join(root, 'public', 'chromashift_engine.js');
const wasmPath = join(root, 'public', 'chromashift_engine.wasm');
const assertFloors = process.argv.includes('--assert');

let wasmBinary;
try {
  wasmBinary = await readFile(wasmPath);
} catch {
  console.error(
    `bench:wasm — ${wasmPath} not found. Build it first: npm run build:wasm`,
  );
  process.exit(1);
}

const glue = await import(pathToFileURL(gluePath).href);
const mod = await glue.default({ wasmBinary });

if (typeof mod._computeClassificationMaskLut !== 'function') {
  console.error('bench:wasm — stale WASM build. Rebuild: npm run build:wasm:force');
  process.exit(1);
}

console.log(`bench:wasm — ${WIDTH}×${HEIGHT} golden image (${(BYTE_LENGTH / 1e6).toFixed(1)} MB RGBA)`);
const { results, maskMismatches, flowMismatches, avgLum } = runBenchmark(
  mod, { pixels: buildGoldenImage() },
);

let failed = false;

for (const [name, { ms, mpxps, floor, pass }] of Object.entries(results)) {
  const verdict = pass ? 'ok' : `BELOW FLOOR ${floor} Mpx/s`;
  console.log(
    `  ${name.padEnd(30)} ${ms.toFixed(1).padStart(7)} ms  ${mpxps.toFixed(0).padStart(6)} Mpx/s  ${verdict}`,
  );
  if (!pass) failed = true;
}

console.log(`  avgLum ${avgLum.toFixed(6)} · mask vs maskLut mismatches: ${maskMismatches}`);
if (maskMismatches !== 0) failed = true;

// The motion-flow fixture is pinned against the TypeScript reference; a
// mismatch means the SIMD128 coarse level and the scalar bodies have diverged,
// which the host C++ tests cannot see.
console.log(`  motion-flow fixture mismatches: ${flowMismatches}`);
if (flowMismatches !== 0) failed = true;

if (!assertFloors) {
  console.log('bench:wasm — report only (pass --assert to enforce the floors)');
  process.exit(0);
}

if (failed) {
  console.error('bench:wasm — FAILED');
  process.exit(1);
}
console.log('bench:wasm — all kernels above their throughput floors');
