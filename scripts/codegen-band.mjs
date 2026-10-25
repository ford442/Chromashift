#!/usr/bin/env node
/**
 * Generate C++ band threshold header from shared/band.json.
 *
 *   node scripts/codegen-band.mjs
 *
 * TypeScript, WGSL, and GLSL consume the same table via
 * src/engine/math/bandClassification.ts (which imports shared/band.json) and
 * src/engine/shaders/bandLiterals.ts (BAND_WGSL / BAND_GLSL). This script is
 * C++-only — run it before `make -C cpp` when the JSON changes, or via
 * `npm run codegen:band`. Web/GLSL builds do not require emsdk.
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

// Band index i is "the first i where rgb > threshold[i]", so the table must be
// finite numbers, highest first — a string or an out-of-order entry would
// compile to a header that classifies differently from TS and WGSL.
const problems = [];
if (entries.length === 0) problems.push('no bands');
entries.forEach(([name, v], i) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    problems.push(`${name}: ${JSON.stringify(v)} is not a finite number`);
  } else if (i > 0 && !(v < values[i - 1])) {
    problems.push(`${name}: ${v} is not below ${entries[i - 1][0]} (${values[i - 1]})`);
  }
});
if (problems.length > 0) {
  console.error(`codegen-band: invalid ${jsonPath}:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

/** A C++ float literal: `125.0f`, `125.5f` (`${v}.0f` turned 125.5 into `125.5.0f`). */
const floatLiteral = (v) => (Number.isInteger(v) ? `${v}.0f` : `${v}f`);

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
  ...values.map((v, i) => `    ${floatLiteral(v)}${i < values.length - 1 ? ',' : ''}`),
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
