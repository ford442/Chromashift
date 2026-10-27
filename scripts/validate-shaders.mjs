#!/usr/bin/env node
/**
 * Validate every shader the app can build, without a GPU.
 *
 * 1. Dumps the shader corpus — every WGSL module any pipeline is built from
 *    (all graph presets × layer counts × temporal term × presentation, the
 *    inspect views, the gpu-chores kernels) and the WebGL GLSL — by running
 *    `src/engine/shaders/shaderBindings.test.ts` with `SHADER_DUMP_DIR` set.
 * 2. Runs `naga` over every `.wgsl` file (the WGSL front end and validator wgpu
 *    uses: types, uniformity, address spaces, entry-point interfaces).
 * 3. Runs `glslangValidator` over every `.vert` / `.frag` file (GLSL ES 3.00).
 *
 * Install the tools once: `cargo install naga-cli --locked` and your
 * platform's `glslang` (`apt-get install glslang-tools`, `brew install
 * glslang`). Without glslang the GLSL step is skipped with a warning unless
 * `--require-glslang` is passed (CI passes it).
 *
 * Usage: node scripts/validate-shaders.mjs [--dir test-results/shaders] [--no-dump] [--require-glslang]
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const dir = resolve(option('--dir', 'test-results/shaders'));
const requireGlslang = args.includes('--require-glslang');

function has(tool, versionFlag) {
  return spawnSync(tool, [versionFlag], { stdio: 'ignore' }).status === 0;
}

if (!args.includes('--no-dump')) {
  const dump = spawnSync(
    'npx',
    ['vitest', 'run', 'src/engine/shaders/shaderBindings.test.ts'],
    { stdio: 'inherit', env: { ...process.env, SHADER_DUMP_DIR: dir } },
  );
  if (dump.status !== 0) {
    console.error('validate-shaders: the shader corpus test failed; nothing was validated.');
    process.exit(dump.status ?? 1);
  }
}

const files = readdirSync(dir);
const failures = [];

function validate(tool, toolArgs, file) {
  const result = spawnSync(tool, [...toolArgs, join(dir, file)], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() });
}

if (!has('naga', '--version')) {
  console.error('validate-shaders: `naga` not found. Install it with `cargo install naga-cli --locked`.');
  process.exit(1);
}
const wgsl = files.filter((file) => file.endsWith('.wgsl'));
for (const file of wgsl) validate('naga', [], file);
console.log(`validate-shaders: naga checked ${wgsl.length} WGSL modules`);

const glsl = files.filter((file) => file.endsWith('.vert') || file.endsWith('.frag'));
if (has('glslangValidator', '--version')) {
  for (const file of glsl) validate('glslangValidator', [], file);
  console.log(`validate-shaders: glslangValidator checked ${glsl.length} GLSL shaders`);
} else if (requireGlslang) {
  console.error('validate-shaders: `glslangValidator` not found and --require-glslang was given.');
  process.exit(1);
} else {
  console.warn(`validate-shaders: glslangValidator not found; skipped ${glsl.length} GLSL shaders.`);
}

if (failures.length > 0) {
  for (const { file, output } of failures) console.error(`\n✗ ${file}\n${output}`);
  console.error(`\nvalidate-shaders: ${failures.length} shader(s) failed validation (sources in ${dir}).`);
  process.exit(1);
}
console.log('validate-shaders: OK');
