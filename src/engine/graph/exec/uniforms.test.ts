import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RENDERER_STATE_DEFAULTS } from '../../../state/defaults';
import { CompositorPass } from '../../CompositorPass';
import { WebGPUPipelines } from '../../WebGPUPipelines';
import { durationToDecay } from '../../math/decay';
import type { RendererState } from '../../types/RendererState';
import { compileGraph, resetGraphCompileCache } from '../compile';
import { buildDefaultGraph } from '../defaultGraph';
import { createUniformData, packUniforms, uniformOffset } from '../templates/uniformLayout';
import { BAND_LAYER_UNIFORMS, PERSIST_UNIFORMS, compositorUniformLayout } from '../templates/wgsl';
import { createFakeGpu, fakeRendererState } from './__fixtures__/fakeDevice';
import {
  bandLayerUniforms,
  compositorUniforms,
  frameLayerOpacities,
  persistUniforms,
  rendererStateValue,
} from './uniforms';
import { WebGpuGraphExecutor } from './WebGpuGraphExecutor';

const minimal = (overrides: Partial<RendererState> = {}): RendererState => ({
  layers: [{ angleDeg: 0 }, { angleDeg: 0 }, { angleDeg: 0 }],
  avgLuminance: 128,
  ...overrides,
});

const stateWithLayers = (count: number, overrides: Partial<RendererState> = {}): RendererState =>
  fakeRendererState({
    layers: Array.from({ length: count }, (_, i) => ({ angleDeg: i * 7 })),
    layerOpacities: Array.from({ length: count }, (_, i) => 0.2 + i * 0.05),
    layerOpacity: 0.8,
    diagnosticsOpacity: 0.3,
    halfOverlayAlpha: 0.25,
    outputMode: 2,
    tracerMode: 1,
    diagnosticsMode: true,
    ...overrides,
  });

describe('rendererStateValue', () => {
  it('falls back to the one table of defaults', () => {
    const state = minimal();
    for (const key of Object.keys(RENDERER_STATE_DEFAULTS) as (keyof typeof RENDERER_STATE_DEFAULTS)[]) {
      expect(rendererStateValue(state, key)).toBe(RENDERER_STATE_DEFAULTS[key]);
    }
  });

  it('never overrides a value the state carries, falsy ones included', () => {
    const state = minimal({ stampBoost: 0, paused: false, tracerBelowDuration: 0, layerOpacity: 0 });
    expect(rendererStateValue(state, 'stampBoost')).toBe(0);
    expect(rendererStateValue(state, 'layerOpacity')).toBe(0);
  });
});

describe('state → uniform values', () => {
  it('folds the global opacity into every per-layer one', () => {
    expect(frameLayerOpacities(minimal({ layerOpacity: 0.5, layerOpacities: [1, 0.5] })))
      .toEqual([0.5, 0.25, 0.5]);
  });

  it('band-layer: a mask is claimed only when one is bound and colour mode is Fixed', () => {
    const fixed = minimal({ colorMode: 0 });
    expect(bandLayerUniforms(fixed, { layerIndex: 0, hasClassificationMask: true }).useMask).toBe(1);
    expect(bandLayerUniforms(fixed, { layerIndex: 0, hasClassificationMask: false }).useMask).toBe(0);
    expect(bandLayerUniforms(minimal(), { layerIndex: 0, hasClassificationMask: true }).useMask).toBe(0);
  });

  it('band-layer: the LUT is sampled only when a profile LUT exists and the mode asks for it', () => {
    const lut = new Uint8Array(4);
    expect(bandLayerUniforms(minimal({ colorProfileLut: lut, colorProfileMode: 1 }), { layerIndex: 0, hasClassificationMask: false }).profileMode).toBe(1);
    expect(bandLayerUniforms(minimal({ colorProfileMode: 1 }), { layerIndex: 0, hasClassificationMask: false }).profileMode).toBe(0);
    expect(bandLayerUniforms(minimal({ colorProfileLut: lut }), { layerIndex: 0, hasClassificationMask: false }).profileMode).toBe(0);
  });

  it('persist: each timescale decays by its own duration', () => {
    const state = minimal({ tracerAboveDuration: 400, tracerBelowDuration: 4000, peakCollisionsOnly: true });
    expect(persistUniforms(state, { role: 'above', fps: 30 }).decayFactor).toBe(durationToDecay(400, 30));
    expect(persistUniforms(state, { role: 'below', fps: 30 }).decayFactor).toBe(durationToDecay(4000, 30));
    expect(persistUniforms(state, { role: 'below', fps: 30 }).peakMode).toBe(1);
  });

  it('compositor: viewport transforms reach the shader only on request, and only over the composite', () => {
    const zoomed = minimal({ viewportQuarterZoom: true, viewportHalfOverlay: true });
    expect(compositorUniforms(zoomed, 3).viewportQuarterZoom).toBe(0);
    expect(compositorUniforms(zoomed, 3, { viewportTransforms: true }).viewportQuarterZoom).toBe(1);
    expect(compositorUniforms(zoomed, 3, { viewportTransforms: true }).viewportHalfOverlay).toBe(1);
    const tracerView = { ...zoomed, mainViewMode: 1 };
    expect(compositorUniforms(tracerView, 3, { viewportTransforms: true }).viewportQuarterZoom).toBe(0);
  });
});

describe('the hand encoder and the graph executor write the same bytes', () => {
  const CANVAS = { width: 320, height: 240 };

  function executorCompositorBytes(layerCount: number, state: RendererState) {
    const gpu = createFakeGpu();
    const pipelines = new WebGPUPipelines(gpu.device, 'bgra8unorm', 'rgba16float', layerCount);
    const sampler = gpu.device.createSampler({});
    const source = gpu.device.createTexture({ size: [CANVAS.width, CANVAS.height, 1], format: 'rgba8unorm', usage: 0 });

    const hand = new CompositorPass(gpu.device, pipelines, sampler);
    hand.writeUniforms(compositorUniforms(state, layerCount));
    const handBytes = gpu.bufferContents.get(hand.uniformBuf.label)!;

    resetGraphCompileCache();
    const executor = new WebGpuGraphExecutor(gpu.device, pipelines, 'rgba16float', 'bgra8unorm', sampler, sampler);
    executor.setGraph(compileGraph(buildDefaultGraph(layerCount), 'webgpu'));
    executor.encode(
      gpu.device.createCommandEncoder(),
      { source, classificationMask: source, hasClassificationMask: false, profileLut: source },
      {
        state,
        outputView: {} as GPUTextureView,
        width: CANVAS.width,
        height: CANVAS.height,
        fps: 30,
      },
    );
    // The blend node's block is the one other buffer of the compositor's size.
    const bytes = compositorUniformLayout(layerCount).bytes;
    const skip = new Set([hand.uniformBuf.label]);
    const graphLabel = [...gpu.bufferSizes]
      .find(([label, size]) => size === bytes && !skip.has(label) && gpu.bufferContents.has(label))![0];
    return { handBytes, graphBytes: gpu.bufferContents.get(graphLabel)! };
  }

  it.each([1, 3, 5, 8])('compositor uniforms at %i layers', (layerCount) => {
    const state = stateWithLayers(layerCount);
    const { handBytes, graphBytes } = executorCompositorBytes(layerCount, state);
    expect([...handBytes]).toEqual([...graphBytes]);

    // And the fields after the opacities sit where the shader reads them. The
    // hand compositor used to write three opacities at slots 4–6 whatever the
    // layer count, so at any other count everything below landed a slot off.
    const layout = compositorUniformLayout(layerCount);
    const view = new DataView(handBytes.buffer, handBytes.byteOffset, handBytes.byteLength);
    expect(view.getFloat32(uniformOffset(layout, 'diagnosticsOpacity'), true)).toBeCloseTo(0.3, 6);
    expect(view.getUint32(uniformOffset(layout, 'outputMode'), true)).toBe(2);
    expect(view.getFloat32(uniformOffset(layout, 'halfOverlayAlpha'), true)).toBeCloseTo(0.25, 6);
    expect(view.getFloat32(uniformOffset(layout, `layerOpacity${layerCount - 1}`), true))
      .toBeCloseTo(0.8 * (0.2 + (layerCount - 1) * 0.05), 6);
  });

  it('band-layer and persist blocks pack identically from either path', () => {
    // Both encoders now call the same builders, so this pins the packing:
    // field-for-field, the block is the shipped one.
    const state = stateWithLayers(3, { colorMode: 2, sobelEnabled: true, tracerThreshold: 0.2 });
    const band = packUniforms(BAND_LAYER_UNIFORMS, bandLayerUniforms(state, { layerIndex: 1, hasClassificationMask: false }), createUniformData(BAND_LAYER_UNIFORMS));
    expect([...band.f32]).toEqual([
      128, Math.fround(0.8 * 0.25), 2, 0, 1, 0, 0, 1,
    ]);
    const persist = packUniforms(PERSIST_UNIFORMS, persistUniforms(state, { role: 'above', fps: 30 }), createUniformData(PERSIST_UNIFORMS));
    expect(persist.f32[0]).toBe(Math.fround(durationToDecay(RENDERER_STATE_DEFAULTS.tracerAboveDuration, 30)));
    expect(persist.f32[1]).toBe(Math.fround(0.2));
    expect(persist.f32[2]).toBe(Math.fround(RENDERER_STATE_DEFAULTS.stampBoost));
    expect(persist.u32[3]).toBe(1);
  });
});

describe('no renderer spells its own default', () => {
  const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
  const defaulted = Object.keys(RENDERER_STATE_DEFAULTS).join('|');
  const inlineFallback = new RegExp(`state\\??\\.(${defaulted})\\s*\\?\\?`);

  it('reads every optional RendererState field through rendererStateValue()', () => {
    const offenders = sources(ENGINE).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, at: `${relative(ENGINE, file)}:${i + 1}` }))
        .filter(({ line }) => inlineFallback.test(line) || /\?\?\s*(1\.8|0\.85)\b/.test(line))
        .map(({ at, line }) => `${at}  ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
