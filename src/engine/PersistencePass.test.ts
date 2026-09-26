import { describe, expect, it, vi } from 'vitest';
import { PersistencePass, type PersistenceEncodeParams } from './PersistencePass';
import type { LayerTextures } from './BindGroupCache';

/**
 * `PersistencePass.encode()` picks the compute-fed coincidence path whenever
 * `useComputePersistence()` is true, and that dispatch used to share the
 * frame's own `enc` with everything downstream — layers, compositor, the
 * composite render passes reading its output. A `GPUValidationError` in that
 * dispatch doesn't throw in JS; it silently discards the *whole command
 * buffer* it was recorded into at `submit()`, which meant a broken
 * coincidence pass could blank the entire visible frame, not just the tracer.
 *
 * These tests exercise the isolated `encodeCoincidence` helper directly via
 * `Object.create`, rather than constructing a full `PersistencePass` (which
 * would otherwise require faking most of `WebGPUPipelines`) — the behaviour
 * under test only touches the fields it assigns below.
 */
interface CoincidenceHarnessFields {
  device: GPUDevice;
  coincidenceBackend: {
    encodeCoincidenceInto: ReturnType<typeof vi.fn>;
  };
  stampTexture: GPUTexture;
  diagnosticTextures: [GPUTexture, GPUTexture];
  tracerWidth: number;
  tracerHeight: number;
}

interface CoincidenceHarness {
  encodeCoincidence(
    layerTextures: LayerTextures,
    writeIdx: 0 | 1,
    params: PersistenceEncodeParams,
  ): void;
}

function makeHarness() {
  const finish = vi.fn(() => 'command-buffer');
  const encoder = { finish };
  const createCommandEncoder = vi.fn(() => encoder);
  const submit = vi.fn();
  const device = { createCommandEncoder, queue: { submit } } as unknown as GPUDevice;
  const encodeCoincidenceInto = vi.fn();

  const fields: CoincidenceHarnessFields = {
    device,
    coincidenceBackend: { encodeCoincidenceInto },
    stampTexture: {} as GPUTexture,
    diagnosticTextures: [{} as GPUTexture, {} as GPUTexture],
    tracerWidth: 64,
    tracerHeight: 64,
  };
  const pass = Object.assign(
    Object.create(PersistencePass.prototype) as CoincidenceHarness,
    fields,
  );

  return { pass, createCommandEncoder, submit, encoder, encodeCoincidenceInto };
}

const layerTextures = [{}, {}, {}] as unknown as LayerTextures;
const params: PersistenceEncodeParams = {
  fps: 30,
  colorThresh: 0.05,
  tracerMode: 0,
  stampBoost: 1.8,
  peakMode: 0,
  belowDuration: 500,
  aboveDuration: 2000,
  paused: false,
};

describe('PersistencePass coincidence isolation', () => {
  it('records the coincidence dispatch into its own command buffer, not the caller’s', () => {
    const { pass, createCommandEncoder, submit, encoder, encodeCoincidenceInto } = makeHarness();

    pass.encodeCoincidence(layerTextures, 0, params);

    expect(createCommandEncoder).toHaveBeenCalledTimes(1);
    const [encArg] = encodeCoincidenceInto.mock.calls[0];
    expect(encArg).toBe(encoder);
    expect(submit).toHaveBeenCalledWith([encoder.finish()]);
  });

  it('does not throw, and never reaches the queue, when the dispatch fails validation', () => {
    const { pass, submit, encodeCoincidenceInto } = makeHarness();
    encodeCoincidenceInto.mockImplementation(() => {
      throw new Error('Validation error: bind group layout mismatch');
    });

    expect(() => pass.encodeCoincidence(layerTextures, 1, params)).not.toThrow();
    // The broken buffer is abandoned rather than finished/submitted, so it
    // cannot take any other command buffer down with it.
    expect(submit).not.toHaveBeenCalled();
  });
});
