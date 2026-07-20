#!/usr/bin/env node
/**
 * Generate C++ band threshold header from shared/band.json.
 *
 *   node scripts/codegen-band.mjs
 *
 * TypeScript and WGSL consume the same table via src/engine/math/bandClassification.ts
 * (which imports shared/band.json). Run this script before `make -C cpp` when the JSON
 * changes, or via `npm run codegen:band`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = join(root, 'shared', 'band.json');
const outPath = join(root, 'cpp', 'band_table.h');

const { bands } = JSON.parse(readFileSync(jsonPath, 'utf8'));
const entries = Object.entries(bands);
const values = entries.map(([, v]) => v);

const lines = [
  '#pragma once',
  '/**',
  ' * Auto-generated from shared/band.json — do not edit by hand.',
  ' * Regenerate: npm run codegen:band',
  ' */',
  '',
  '#include <cstddef>',
  '',
  'namespace chromashift {',
  '',
  `constexpr std::size_t BAND_COUNT = ${values.length};`,
  `constexpr std::size_t DARK_BAND_INDEX = ${values.length};`,
  '',
  'constexpr float BAND_THRESHOLDS[BAND_COUNT] = {',
  ...values.map((v, i) => `    ${v}.0f${i < values.length - 1 ? ',' : ''}`),
  '};',
  '',
  '} // namespace chromashift',
  '',
];

const next = lines.join('\n');
let prev = null;
try {
  prev = readFileSync(outPath, 'utf8');
} catch {
  // first generation
}
if (prev === next) {
  console.log(`Unchanged ${outPath} (${values.length} thresholds)`);
} else {
  writeFileSync(outPath, next);
  console.log(`Wrote ${outPath} (${values.length} thresholds)`);
}
