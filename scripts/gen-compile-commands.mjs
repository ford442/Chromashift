#!/usr/bin/env node
/**
 * Emit `cpp/compile_commands.json` for clangd. Run it through make —
 * `npm run compile-commands` / `make -C cpp compile-commands` — which passes
 * the compiler, the flags and the file lists from cpp/Makefile, so the database
 * is never a second copy of the build's flags that can drift from it.
 *
 * Why an emitter and not `bear`/`compiledb`: a tool that intercepts an actual
 * build would need the emsdk build to run first, and would record emcc's
 * driver invocations rather than something clangd can replay.
 *
 * One entry per translation unit, each a real `-c <file> -o <file>.o` compile:
 *
 * - **Engine TUs** (chromashift_engine.cpp, motion_flow.cpp) get a **wasm32**
 *   entry when `$EMSDK` points at an emsdk: emsdk's own clang, the Emscripten
 *   sysroot and `-msimd128`, i.e. what emcc compiles. clangd then sees all of
 *   the code — every `#if CS_HAS_SIMD` block sits in front of a scalar tail that
 *   is always compiled, so nothing is greyed out. Without emsdk they fall back
 *   to the host (g++) entry, and the SIMD blocks grey out as before.
 * - **Host-only TUs** (tests/test_engine.cpp) always get the host entry.
 * - **wasm-only TUs** (tests/simd_parity.cpp and its scalar twins) are listed
 *   only with emsdk: they `#error` on a host target by design.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cppDir = resolve(scriptDir, '..', 'cpp');

const { values } = parseArgs({
  options: {
    'host-cxx': { type: 'string' },
    'host-flags': { type: 'string' },
    'wasm-flags': { type: 'string' },
    engine: { type: 'string' },
    'host-only': { type: 'string', default: '' },
    'wasm-only': { type: 'string', default: '' },
  },
});

for (const required of ['host-cxx', 'host-flags', 'wasm-flags', 'engine']) {
  if (!values[required]) {
    console.error(`gen-compile-commands: missing --${required}. Run it via: make -C cpp compile-commands`);
    process.exit(1);
  }
}

const words = (list) => list.split(/\s+/).filter(Boolean);
const hostCommand = [values['host-cxx'], ...words(values['host-flags'])];

/** emsdk's clang plus the sysroot emcc compiles against, or null without emsdk. */
function wasmCommand() {
  const emsdk = process.env.EMSDK;
  if (!emsdk) return null;
  const clang = join(emsdk, 'upstream', 'bin', 'clang++');
  const sysroot = join(emsdk, 'upstream', 'emscripten', 'cache', 'sysroot');
  if (!existsSync(clang) || !existsSync(sysroot)) {
    const missing = existsSync(clang) ? 'a sysroot yet (run emcc once to populate its cache)' : 'upstream/bin/clang++';
    console.warn(`⚠️   $EMSDK=${emsdk} has no ${missing} — writing host entries`);
    return null;
  }
  return [clang, '--target=wasm32-unknown-emscripten', `--sysroot=${sysroot}`, ...words(values['wasm-flags'])];
}

const wasm = wasmCommand();

const entry = (command, file) => {
  const output = file.replace(/\.cpp$/, '.o');
  return { directory: cppDir, file, output, arguments: [...command, '-c', file, '-o', output] };
};

const entries = [
  ...words(values.engine).map((file) => entry(wasm ?? hostCommand, file)),
  ...words(values['host-only']).map((file) => entry(hostCommand, file)),
  ...(wasm ? words(values['wasm-only']).map((file) => entry(wasm, file)) : []),
];

const target = join(cppDir, 'compile_commands.json');
writeFileSync(target, `${JSON.stringify(entries, null, 2)}\n`);
console.log(
  `✅  wrote ${target} (${entries.length} translation units; engine: ${wasm ? 'wasm32 + SIMD128' : `host ${values['host-cxx']}`})`,
);
