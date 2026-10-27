import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compositorFragmentSource,
  fragmentShaderGreenYellow,
  fragmentShaderRedOrange,
  fragmentShaderVioletBlue,
  persistenceFragmentSource,
} from '../shaders';
import { WGSL_COLOR_HELPERS } from '../shaders/common';
import { LAYER_FRAGMENT_SOURCE } from '../webgl/shaders/layers';
import { PERSISTENCE_FRAGMENT_SOURCE } from '../webgl/shaders/persistence';
import { COMPOSITOR_FRAGMENT_SOURCE } from '../webgl/shaders/compositor';
import {
  GLSL_BAND_COLOR_HELPERS,
  GLSL_GRADIENT_LAYER_BRANCH,
} from '../webgl/shaders/bandGlsl';
import { COINCIDENCE_COMPUTE_SHADER } from '../compute/chores/kernels';
import { normaliseShaderSource } from './shaderText';
import { compileGraph } from './compile';
import { buildDefaultGraph } from './defaultGraph';

/**
 * Pixel-identity guard for the pass-graph migration.
 *
 * `__golden__/` holds the hand-written shader sources exactly as they shipped
 * before the templates replaced them. Comments and indentation cannot change a
 * rendered pixel, so the comparison runs on normalised source — but any change
 * to the emitted token stream fails here, on both backends.
 */
const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '__golden__');

function expectMatchesGolden(emitted: string, goldenFile: string): void {
  const golden = readFileSync(join(GOLDEN_DIR, goldenFile), 'utf8');
  expect(normaliseShaderSource(emitted)).toBe(normaliseShaderSource(golden));
}

describe('default-graph WGSL matches the hand-written pipeline', () => {
  it.each([
    ['layer 0 (red / orange)', fragmentShaderRedOrange, 'band-layer-0.wgsl'],
    ['layer 1 (violet / blue)', fragmentShaderVioletBlue, 'band-layer-1.wgsl'],
    ['layer 2 (green / yellow)', fragmentShaderGreenYellow, 'band-layer-2.wgsl'],
  ])('%s', (_name, emitted, goldenFile) => {
    expectMatchesGolden(emitted, goldenFile);
  });

  it('emits the shared colour helpers unchanged', () => {
    expectMatchesGolden(WGSL_COLOR_HELPERS, 'color-helpers.wgsl');
  });

  it('emits the coincidence + decay pass unchanged', () => {
    expectMatchesGolden(persistenceFragmentSource, 'coincidence-decay.wgsl');
  });

  it('emits the compositor pass unchanged', () => {
    expectMatchesGolden(compositorFragmentSource, 'compositor.wgsl');
  });

  it('emits the coincidence compute kernel unchanged', () => {
    expectMatchesGolden(COINCIDENCE_COMPUTE_SHADER, 'coincidence-compute.wgsl');
  });
});

describe('the default graph the executor draws emits the goldens', () => {
  // The named sources above are re-exports for tests and tools; this is the
  // text the WebGPU renderer actually binds, straight out of the compiler.
  const emitted = new Map(
    compileGraph(buildDefaultGraph(3), 'webgpu').emitted.map((pass) => [pass.nodeId, pass.fragment]),
  );
  it.each([
    ['layer0', 'band-layer-0.wgsl'],
    ['layer1', 'band-layer-1.wgsl'],
    ['layer2', 'band-layer-2.wgsl'],
    ['tracer-below', 'coincidence-decay.wgsl'],
    ['tracer-above', 'coincidence-decay.wgsl'],
    ['composite', 'compositor.wgsl'],
  ])('%s', (nodeId, goldenFile) => {
    expectMatchesGolden(emitted.get(nodeId)!, goldenFile);
  });
});

describe('default-graph GLSL matches the hand-written diagnostic backend', () => {
  it('emits the band-layer fragment shader unchanged', () => {
    expectMatchesGolden(LAYER_FRAGMENT_SOURCE, 'band-layer.glsl');
  });

  it('emits the band colour helpers unchanged', () => {
    expectMatchesGolden(GLSL_BAND_COLOR_HELPERS, 'band-color-helpers.glsl');
  });

  it('emits the gradient branch unchanged', () => {
    expectMatchesGolden(GLSL_GRADIENT_LAYER_BRANCH, 'gradient-branch.glsl');
  });

  it('emits the coincidence + decay pass unchanged', () => {
    expectMatchesGolden(PERSISTENCE_FRAGMENT_SOURCE, 'coincidence-decay.glsl');
  });

  it('emits the compositor pass unchanged', () => {
    expectMatchesGolden(COMPOSITOR_FRAGMENT_SOURCE, 'compositor.glsl');
  });
});
