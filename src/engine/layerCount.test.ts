import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebGPUPipelines } from './WebGPUPipelines';
import { buildRendererState } from './buildRendererState';
import { MAX_LAYER_COUNT, assertLayerCount, clampLayerCount } from './graph/layerSpecs';
import {
  emitCoincidenceDecayWgsl,
  emitCompositorWgsl,
} from './graph/templates/wgsl';
import { sameLayerTextures } from './BindGroupCache';
import { chromashiftReducer } from '../state/chromashiftReducer';
import { createInitialState } from '../state/defaults';
import type { LayerState, RendererState } from './types/RendererState';
import type { LayersSlice } from '../state/types';

/**
 * The layer count is data, not a type-level width.
 *
 * These assignments are the type-level half of the contract: each one hands a
 * variable-length array to a field that used to be a 3-tuple. They compile only
 * while those fields stay arrays — reintroducing `[T, T, T]` anywhere on the
 * renderer or state contract fails `tsc -b`, which `npm run build` runs, before
 * any of the runtime expectations below get a chance to.
 */
describe('layer contract is array-shaped, not tuple-shaped', () => {
  it('accepts a renderer state of any layer count', () => {
    const fiveLayers: LayerState[] = Array.from({ length: 5 }, () => ({ angleDeg: 0 }));
    const state: RendererState = {
      layers: fiveLayers,
      layerOpacities: [1, 1, 1, 1, 1],
      avgLuminance: 128,
    };
    expect(state.layers).toHaveLength(5);
    expect(state.layerOpacities).toHaveLength(5);
  });

  it('accepts a layers slice of any layer count', () => {
    const base = createInitialState().layers;
    const slice: LayersSlice = {
      ...base,
      count: 8,
      angles: Array.from({ length: 8 }, () => 0),
      extensions: Array.from({ length: 8 }, (_, i) => i * 40),
      opacities: Array.from({ length: 8 }, () => 1),
    };
    expect(slice.angles).toHaveLength(8);
  });
});

describe('assertLayerCount / clampLayerCount', () => {
  it.each([1, 3, 5, 8, MAX_LAYER_COUNT])('accepts %i', (count) => {
    expect(assertLayerCount(count)).toBe(count);
  });

  it.each([0, -1, 1.5, MAX_LAYER_COUNT + 1, Number.NaN])('rejects %s', (count) => {
    expect(() => assertLayerCount(count)).toThrow(RangeError);
  });

  it('clamps rather than throwing, for counts that arrive from a file or URL', () => {
    expect(clampLayerCount(0)).toBe(1);
    expect(clampLayerCount(99)).toBe(MAX_LAYER_COUNT);
    expect(clampLayerCount(undefined)).toBe(3);
    expect(clampLayerCount('four')).toBe(3);
  });
});

describe('the reducer keeps count and the per-layer arrays in step', () => {
  it('grows every array together, preserving the values already set', () => {
    let state = createInitialState();
    state = chromashiftReducer(state, {
      type: 'layers/setPerLayer', field: 'extensions', layer: 1, value: 42,
    });

    state = chromashiftReducer(state, { type: 'layers/setCount', count: 5 });

    expect(state.layers.count).toBe(5);
    expect(state.layers.angles).toHaveLength(5);
    expect(state.layers.opacities).toEqual([1, 1, 1, 1, 1]);
    // The edited value survives; the two new layers continue the rate ladder.
    expect(state.layers.extensions).toEqual([130, 42, 330, 70, 170]);
  });

  it('shrinks by dropping the tail', () => {
    let state = chromashiftReducer(createInitialState(), { type: 'layers/setCount', count: 5 });
    state = chromashiftReducer(state, { type: 'layers/setCount', count: 2 });
    expect(state.layers.count).toBe(2);
    expect(state.layers.extensions).toEqual([130, 230]);
  });

  it('clamps an out-of-range count instead of throwing', () => {
    const state = chromashiftReducer(createInitialState(), { type: 'layers/setCount', count: 40 });
    expect(state.layers.count).toBe(MAX_LAYER_COUNT);
    expect(state.layers.angles).toHaveLength(MAX_LAYER_COUNT);
  });

  it('returns the same state for a no-op count change', () => {
    const state = createInitialState();
    expect(chromashiftReducer(state, { type: 'layers/setCount', count: 3 })).toBe(state);
  });

  it('ignores a write to a layer outside the current count', () => {
    const state = createInitialState();
    const next = chromashiftReducer(state, {
      type: 'layers/setPerLayer', field: 'extensions', layer: 7, value: 12,
    });
    expect(next).toBe(state);
    expect(next.layers.extensions).toHaveLength(3);
  });

  it('resizes the arrays when a patch carries a bare count', () => {
    const state = chromashiftReducer(createInitialState(), {
      type: 'layers/patch', patch: { count: 4 },
    });
    expect(state.layers.angles).toHaveLength(4);
    expect(state.layers.opacities).toHaveLength(4);
  });
});

describe('buildRendererState follows the angle array', () => {
  it('sizes its layer array from the angles it is given', () => {
    const state = chromashiftReducer(createInitialState(), { type: 'layers/setCount', count: 5 });
    const rendererState = buildRendererState(state, state.layers.angles);
    expect(rendererState.layers).toHaveLength(5);
  });

  it('reuses and resizes one array per slot instead of reallocating', () => {
    const app = createInitialState();
    const first = buildRendererState(app, [0, 0, 0], {}, 'main');
    const entries = first.layers;

    const grown = buildRendererState(app, [0, 0, 0, 0, 0], {}, 'main');
    expect(grown).toBe(first);
    expect(grown.layers).toHaveLength(5);
    // The layers that already existed are the same objects, not replacements.
    expect(grown.layers[0]).toBe(entries[0]);

    const shrunk = buildRendererState(app, [0, 0], {}, 'main');
    expect(shrunk.layers).toHaveLength(2);
  });

  it('mirrors every odd layer, which is the shipped three-layer geometry', () => {
    const rendererState = buildRendererState(createInitialState(), [10, 20, 30, 40]);
    expect(rendererState.layers.map((l) => l.flipY)).toEqual([false, true, false, true]);
    expect(rendererState.layers.map((l) => l.angleDeg)).toEqual([10, 20, 30, 40]);
  });
});

describe('sameLayerTextures', () => {
  const a = {} as GPUTexture;
  const b = {} as GPUTexture;

  it('misses on a different length, so a count change rebuilds the bind group', () => {
    expect(sameLayerTextures([a, b], [a, b, a])).toBe(false);
    expect(sameLayerTextures(null, [a])).toBe(false);
  });

  it('hits only when every texture is the same object, in order', () => {
    expect(sameLayerTextures([a, b], [a, b])).toBe(true);
    expect(sameLayerTextures([a, b], [b, a])).toBe(false);
  });
});

/**
 * The bind-group layouts and the emitted WGSL have to agree about which binding
 * a texture lives at, and both derive it from the layer count rather than from a
 * table someone maintains. This checks them against each other at counts the
 * default session never uses — the failure it guards against is a layout that
 * still reserves bindings 1–3 while the shader reads 1–5.
 */
describe('WebGPU bind-group layouts are generated from the layer count', () => {
  const layouts: GPUBindGroupLayoutDescriptor[] = [];
  const device = {
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => {
      layouts.push(descriptor);
      return { descriptor } as unknown as GPUBindGroupLayout;
    }),
  } as unknown as GPUDevice;

  beforeEach(() => {
    layouts.length = 0;
    vi.stubGlobal('GPUShaderStage', { FRAGMENT: 2, COMPUTE: 4, VERTEX: 1 });
  });

  /** Highest `@group(0) @binding(n)` in an emitted shader. */
  function maxShaderBinding(source: string): number {
    const bindings = [...source.matchAll(/@binding\((\d+)\)/g)].map((m) => Number(m[1]));
    return Math.max(...bindings);
  }

  function bindings(descriptor: GPUBindGroupLayoutDescriptor): number[] {
    return [...descriptor.entries].map((entry) => entry.binding).sort((x, y) => x - y);
  }

  it.each([1, 2, 3, 5, 8, MAX_LAYER_COUNT])('builds every layout at %i layers', (layerCount) => {
    const pipelines = new WebGPUPipelines(device, 'bgra8unorm', 'rgba16float', layerCount);
    expect(pipelines.layerCount).toBe(layerCount);
    // Eleven layouts, every one created without throwing.
    expect(layouts).toHaveLength(11);
    for (const descriptor of layouts) {
      const list = bindings(descriptor);
      // Dense, zero-based, no duplicates — a gap means an entry was dropped.
      expect(list).toEqual(list.map((_, i) => i));
    }
  });

  it.each([1, 2, 3, 5, 8, MAX_LAYER_COUNT])(
    'puts the persist and compositor uniforms where the shader reads them (%i layers)',
    (layerCount) => {
      const pipelines = new WebGPUPipelines(device, 'bgra8unorm', 'rgba16float', layerCount);
      layouts.length = 0;

      const persist = pipelines.createPersistBGL() as unknown as { descriptor: GPUBindGroupLayoutDescriptor };
      expect(bindings(persist.descriptor)).toHaveLength(
        maxShaderBinding(emitCoincidenceDecayWgsl(layerCount)) + 1,
      );

      const compositor = pipelines.createCompositorBGL() as unknown as { descriptor: GPUBindGroupLayoutDescriptor };
      expect(bindings(compositor.descriptor)).toHaveLength(
        maxShaderBinding(emitCompositorWgsl(layerCount, '')) + 1,
      );
    },
  );

  it('rejects a layer count the band table cannot describe', () => {
    expect(() => new WebGPUPipelines(device, 'bgra8unorm', 'rgba16float', 11)).toThrow(RangeError);
  });
});
