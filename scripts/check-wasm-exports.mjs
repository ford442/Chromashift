#!/usr/bin/env node
/**
 * Post-build guard: instantiate the shipped Emscripten glue + wasm and fail if
 * any function in WASM_API_FUNCTIONS is missing from the module object.
 *
 * `make -C cpp verify-exports` only compares the header with EXPORTED_FUNCS;
 * this checks the artifact itself, which is what the browser actually loads and
 * what `logStaleWasmExports()` in src/engine/wasm/loadEngine.ts warns about.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DIR = process.argv[2] ?? 'dist';

function fail(message) {
  console.error(`check:wasm-exports — ${message}`);
  process.exit(1);
}

const typesSrc = await readFile('src/engine/wasm/types.ts', 'utf8');
const listMatch = typesSrc.match(/WASM_API_FUNCTIONS\s*=\s*\[([\s\S]*?)\]/);
if (!listMatch) fail('could not find WASM_API_FUNCTIONS in src/engine/wasm/types.ts');
const expected = [...listMatch[1].matchAll(/'(_\w+)'/g)].map((m) => m[1]);
if (expected.length === 0) fail('parsed zero names from WASM_API_FUNCTIONS — check would be vacuous');

const gluePath = resolve(DIR, 'chromashift_engine.js');
const wasmBinary = await readFile(resolve(DIR, 'chromashift_engine.wasm'))
  .catch(() => fail(`${DIR}/chromashift_engine.wasm not found`));
const glue = await import(pathToFileURL(gluePath).href)
  .catch((err) => fail(`cannot import ${gluePath}: ${err.message}`));
const mod = await glue.default({ wasmBinary });

const missing = expected.filter((fn) => typeof mod[fn] !== 'function');
if (missing.length > 0) {
  fail(`stale WASM build in ${DIR}/ — missing ${missing.length}/${expected.length} exports: ${missing.join(', ')}. `
    + 'Rebuild with: npm run build:wasm');
}
console.log(`check:wasm-exports — ${expected.length}/${expected.length} exports present in ${DIR}/`);
