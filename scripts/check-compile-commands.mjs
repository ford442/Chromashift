#!/usr/bin/env node
/**
 * Assert that `cpp/compile_commands.json` (written by `make -C cpp
 * compile-commands`, gitignored) is what clangd needs and what the build uses:
 *
 *  1. Every `cpp/**\/*.cpp` on disk is an entry. A translation unit added to a
 *     test target but to none of the generator's lists (`--engine`,
 *     `--host-only`, `--wasm-only`) would otherwise be invisible to clangd.
 *  2. Every entry carries the tokens of `CXXFLAGS_COMMON` and never
 *     `-mrelaxed-simd`. The floor below is asserted too, so deleting
 *     `-ffp-contract=off` from the Makefile fails here rather than passing
 *     because the Makefile and the database agree on the wrong thing.
 *  3. With `$EMSDK` set, the engine and the wasm-only TUs are wasm32 entries
 *     carrying `WASM_CXXFLAGS` (`-msimd128`, `-fno-exceptions`, `-fno-rtti`),
 *     not host fallbacks that grey out every `#if CS_HAS_SIMD` block.
 *
 * File lists and flag sets come from cpp/Makefile (`make --eval`), never from a
 * copy here. Without `$EMSDK` the engine entries are host entries and the
 * wasm-only TUs are absent by design (they `#error` on a host target), so a
 * laptop without the SDK passes. CI's `wasm` job passes `--require-wasm`: it
 * has the pinned emsdk, so an entry that could not be emitted as wasm32 is a
 * failure there.
 *
 * Usage: node scripts/check-compile-commands.mjs [--require-wasm]
 *        (run `make -C cpp compile-commands` first)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cppDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cpp');
const requireWasm = process.argv.includes('--require-wasm');

/** Tokens the issue pins regardless of what the Makefile currently says. */
const COMMON_FLOOR = ['-std=c++17', '-Wall', '-Wextra', '-ffp-contract=off'];
const WASM_FLOOR = ['--target=wasm32-unknown-emscripten', '-msimd128'];
/** Relaxed SIMD ops are implementation-defined: they break bit-exact parity. */
const FORBIDDEN = ['-mrelaxed-simd'];

const problems = [];
const fail = (message) => problems.push(message);
const words = (list) => list.split(/\s+/).filter(Boolean);

// ─── Makefile variables ──────────────────────────────────────────────────────

const VARS = ['SRCS', 'TEST_SRC', 'PARITY_SRCS', 'CXXFLAGS_COMMON', 'WASM_CXXFLAGS'];

function makeVariables() {
  const out = execFileSync(
    'make',
    ['-s', '--no-print-directory', '-C', cppDir, '--eval', 'print-%: ; @echo $($*)',
      ...VARS.map((name) => `print-${name}`)],
    { encoding: 'utf8' },
  );
  const lines = out.split('\n');
  const vars = Object.fromEntries(VARS.map((name, i) => [name, words(lines[i] ?? '')]));
  for (const name of VARS) {
    if (vars[name].length === 0) {
      console.error(`check:compile-commands — cpp/Makefile defines no ${name}; the check would be vacuous`);
      process.exit(1);
    }
  }
  return vars;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

function cppFilesOnDisk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((dirent) => {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) return dirent.name.startsWith('.') ? [] : cppFilesOnDisk(path);
    return dirent.name.endsWith('.cpp') ? [relative(cppDir, path)] : [];
  });
}

const databasePath = join(cppDir, 'compile_commands.json');
if (!existsSync(databasePath)) {
  console.error('check:compile-commands — cpp/compile_commands.json not found. Run: make -C cpp compile-commands');
  process.exit(1);
}
const database = JSON.parse(readFileSync(databasePath, 'utf8'));
const entries = new Map(
  database.map((entry) => [
    relative(cppDir, resolve(entry.directory, entry.file)),
    entry.arguments ?? words(entry.command ?? ''),
  ]),
);

const vars = makeVariables();
const engine = new Set(vars.SRCS);
const hostOnly = new Set(vars.TEST_SRC);
const wasmOnly = new Set(vars.PARITY_SRCS);

const emsdk = process.env.EMSDK;
if (requireWasm && !emsdk) {
  fail('--require-wasm but $EMSDK is not set, so the wasm32 entries cannot be emitted');
}
const expectWasm = Boolean(emsdk);

// ─── 1. Every .cpp is an entry ───────────────────────────────────────────────

const onDisk = cppFilesOnDisk(cppDir).sort();
if (onDisk.length === 0) fail('found no .cpp files under cpp/ — the check would be vacuous');

for (const file of onDisk) {
  // wasm-only TUs are emitted only with emsdk; absent without it by design.
  if (!expectWasm && wasmOnly.has(file)) continue;
  if (entries.has(file)) continue;
  fail(engine.has(file) || hostOnly.has(file) || wasmOnly.has(file)
    ? `${file} is listed in cpp/Makefile but missing from compile_commands.json — regenerate it with: make -C cpp compile-commands`
    : `${file} is in no list the compile-commands recipe passes (SRCS, TEST_SRC, PARITY_SRCS) — `
      + 'clangd cannot see it; add it to one of them in cpp/Makefile');
}

// ─── 2 + 3. Flags per entry ──────────────────────────────────────────────────

for (const [file, args] of entries) {
  const has = (token) => args.includes(token);
  const missing = (tokens) => [...new Set(tokens)].filter((token) => !has(token));

  const absentCommon = missing([...COMMON_FLOOR, ...vars.CXXFLAGS_COMMON]);
  if (absentCommon.length > 0) fail(`${file}: missing ${absentCommon.join(' ')} (CXXFLAGS_COMMON)`);

  for (const token of FORBIDDEN) {
    if (has(token)) fail(`${file}: contains ${token}, which breaks bit-exact SIMD/scalar parity`);
  }

  const wantsWasm = expectWasm && (engine.has(file) || wasmOnly.has(file));
  if (wantsWasm) {
    const absentWasm = missing([...WASM_FLOOR, ...vars.WASM_CXXFLAGS]);
    if (absentWasm.length > 0) {
      fail(`${file}: expected a wasm32 SIMD128 entry (EMSDK is set) but it is missing ${absentWasm.join(' ')}; `
        + `compiler is ${basename(args[0] ?? '?')}`);
    }
  } else if (hostOnly.has(file) && has('-msimd128')) {
    fail(`${file}: host-only TU compiled with -msimd128`);
  }
}

// ─── Report ──────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error(`check:compile-commands — ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(
  `check:compile-commands — ${entries.size} entries cover all ${onDisk.length} .cpp files `
  + `(engine: ${expectWasm ? 'wasm32 + SIMD128' : 'host, no $EMSDK'})`,
);
