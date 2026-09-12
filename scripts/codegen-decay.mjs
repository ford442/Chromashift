#!/usr/bin/env node
/**
 * Generate the C++ tracer-decay constants header from shared/decay.json.
 *
 *   node scripts/codegen-decay.mjs
 *
 * TypeScript, WGSL, and GLSL consume the same table via
 * src/engine/math/decay.ts (which imports shared/decay.json) and
 * src/engine/shaders/decayLiterals.ts (DECAY_WGSL / DECAY_GLSL). This script is
 * C++-only — run it before `make -C cpp` when the JSON changes, or via
 * `npm run codegen:decay`. Web/GLSL builds do not require emsdk.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = join(root, 'shared', 'decay.json');
const outPath = join(root, 'cpp', 'decay_table.h');

/** JSON key → C++ constant name. Keep in sync with shared/decay.json. */
const CONSTANTS = [
  ['residualBrightness', 'DECAY_RESIDUAL_BRIGHTNESS',
    'Brightness fraction a tracer retains after its configured duration.'],
  ['overlapDecayExponent', 'DECAY_OVERLAP_EXPONENT',
    'Decay exponent where 2+ layers overlap — fades faster.'],
  ['idleDecayExponent', 'DECAY_IDLE_EXPONENT',
    'Decay exponent with no current overlap — the plain decay rate.'],
];

const { constants } = JSON.parse(readFileSync(jsonPath, 'utf8'));

const missing = CONSTANTS.filter(([key]) => typeof constants[key] !== 'number');
if (missing.length > 0) {
  console.error(
    `❌  shared/decay.json is missing numeric constant(s): ${missing.map(([k]) => k).join(', ')}`,
  );
  process.exit(1);
}

/**
 * C++ float literal for a canonical constant. Preserves the value exactly —
 * `0.05` must not become `0.1` — and adds `.0` only to integers so `1` emits as
 * `1.0f`. Mirrors `shaderFloat()` in src/engine/shaders/decayLiterals.ts; the
 * two must agree, or the C++ and shader literals diverge from the JSON.
 */
const cppFloat = (value) => {
  const literal = String(value);
  const withPoint = Number.isInteger(value) && !/[.eE]/.test(literal)
    ? `${literal}.0`
    : literal;
  return `${withPoint}f`;
};

const lines = [
  '#pragma once',
  '/**',
  ' * Auto-generated from shared/decay.json — do not edit by hand.',
  ' * Regenerate: npm run codegen:decay',
  ' */',
  '',
  'namespace chromashift {',
  '',
  ...CONSTANTS.flatMap(([key, name, doc]) => [
    `// ${doc}`,
    `constexpr float ${name} = ${cppFloat(constants[key])};`,
    '',
  ]),
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
  console.log(`Unchanged ${outPath} (${CONSTANTS.length} constants)`);
} else {
  writeFileSync(outPath, next);
  console.log(`Wrote ${outPath} (${CONSTANTS.length} constants)`);
}
