#!/usr/bin/env node
/**
 * Emit `cpp/compile_commands.json` for the **host** (`g++`) test compile.
 *
 * Why a 10-line emitter and not `bear`/`compiledb`: the C++ side is two
 * translation units built by one Makefile recipe. A tool that intercepts an
 * actual build would add a dependency (and an emsdk/clang toolchain) to get a
 * database we can spell out exactly.
 *
 * The database describes the **host** compile only, so clangd resolves the
 * scalar bodies in `chromashift_engine.cpp`. The SIMD kernels are guarded by
 * `__wasm_simd128__`, which a host `g++`/clang target never defines — those
 * blocks stay greyed out in the editor. That is expected; build them with
 * `make -C cpp release` (emcc `-msimd128`) rather than trying to coax clangd
 * into a wasm32 target here.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cppDir = resolve(scriptDir, '..', 'cpp');

/** Keep in sync with the `$(TEST_BIN)` recipe in cpp/Makefile. */
const CXX = process.env.CXX || 'g++';
const FLAGS = ['-std=c++17', '-Wall', '-Wextra', '-I.'];
const SOURCES = ['chromashift_engine.cpp', 'tests/test_engine.cpp'];
const OUTPUT = 'tests/test_engine';

const entries = SOURCES.map((file) => ({
  directory: cppDir,
  file,
  output: OUTPUT,
  arguments: [CXX, ...FLAGS, ...SOURCES, '-o', OUTPUT, '-lm'],
}));

const target = join(cppDir, 'compile_commands.json');
mkdirSync(cppDir, { recursive: true });
writeFileSync(target, `${JSON.stringify(entries, null, 2)}\n`);
console.log(`✅  wrote ${target} (${entries.length} translation units, host ${CXX})`);
