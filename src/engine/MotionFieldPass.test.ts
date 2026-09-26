import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `MotionFieldPass` borrows its `WebGpuChoreBackend` through
 * `GpuChoreSession`; mocking that module lets these tests drive the backend's
 * encode calls (including throwing one, to stand in for a `GPUValidationError`
 * discarding the command buffer it was recorded into) without constructing a
 * real `WebGpuChoreBackend` against a fake `GPUDevice`.
 */
const isSupported = vi.fn(() => true);
const canAnalyze = vi.fn(() => true);
const encodeMotionFieldInto = vi.fn();
const encodeMotionFlowInto = vi.fn();
const release = vi.fn();

vi.mock('./compute/GpuChoreSession', () => ({
  acquireGpuChoreSession: vi.fn(() => ({
    backend: {
      isSupported,
      canAnalyze,
      support: { reason: null },
      encodeMotionFieldInto,
      encodeMotionFlowInto,
      hasMotionFlow: () => false,
      pollMotionFieldStats: () => {},
      getMotionFieldStats: () => ({ meanMagnitude: 0, movingFraction: 0, cells: 0 }),
    },
    release,
  })),
}));

const { MotionFieldPass } = await import('./MotionFieldPass');

interface FakeDeviceHandle {
  device: GPUDevice;
  createCommandEncoder: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  encoders: { finish: ReturnType<typeof vi.fn> }[];
}

/** A device whose every `createCommandEncoder()` call returns a fresh, trackable encoder. */
function fakeDevice(): FakeDeviceHandle {
  const encoders: { finish: ReturnType<typeof vi.fn> }[] = [];
  const createCommandEncoder = vi.fn(() => {
    const enc = { finish: vi.fn(() => `command-buffer-${encoders.length}`) };
    encoders.push(enc);
    return enc;
  });
  const submit = vi.fn();
  return {
    device: { createCommandEncoder, queue: { submit } } as unknown as GPUDevice,
    createCommandEncoder,
    submit,
    encoders,
  };
}

const source = { width: 640, height: 480 } as unknown as GPUTexture;
const fieldTexture = { label: 'field' } as unknown as GPUTexture;
const flowTexture = { label: 'flow' } as unknown as GPUTexture;

describe('MotionFieldPass.encodeAndSubmit', () => {
  beforeEach(() => {
    isSupported.mockReturnValue(true);
    canAnalyze.mockReturnValue(true);
    encodeMotionFieldInto.mockReset();
    encodeMotionFlowInto.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the field dispatch into its own command buffer, not the caller’s', () => {
    const { device, createCommandEncoder, submit, encoders } = fakeDevice();
    encodeMotionFieldInto.mockReturnValue({
      kind: 'gpu-motion-field',
      fieldTexture,
      width: 160,
      height: 120,
      hasFlow: false,
    });

    const pass = new MotionFieldPass(device);
    const result = pass.encodeAndSubmit(source, 640, 480, { threshold: 0.04 }, false);

    expect(result).toBe(fieldTexture);
    // A dedicated encoder was created for this call — the caller passed none in.
    expect(createCommandEncoder).toHaveBeenCalledTimes(1);
    const [encArg] = encodeMotionFieldInto.mock.calls[0];
    expect(encArg).toBe(encoders[0]);
    expect(encodeMotionFlowInto).not.toHaveBeenCalled();
    // And that buffer was submitted on its own, immediately.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith([encoders[0].finish()]);
  });

  it('runs the Lucas–Kanade flow dispatch in the same isolated buffer as the field', () => {
    const { device, encoders } = fakeDevice();
    encodeMotionFieldInto.mockReturnValue({
      kind: 'gpu-motion-field',
      fieldTexture,
      width: 160,
      height: 120,
      hasFlow: false,
    });
    encodeMotionFlowInto.mockReturnValue(flowTexture);

    const pass = new MotionFieldPass(device);
    const result = pass.encodeAndSubmit(source, 640, 480, { threshold: 0.04 }, true);

    // The field texture is swapped for the flow one — proof the `hasFlow`
    // branch ran — and both dispatches landed in the same isolated buffer.
    expect(result).toBe(flowTexture);
    const [flowEncArg] = encodeMotionFlowInto.mock.calls[0];
    expect(flowEncArg).toBe(encoders[0]);
  });

  it('does not throw and declines cleanly when the field dispatch fails validation', () => {
    const { device, submit } = fakeDevice();
    encodeMotionFieldInto.mockImplementation(() => {
      throw new Error('Validation error: bind group layout mismatch');
    });

    const pass = new MotionFieldPass(device);
    let result: GPUTexture | null = null;
    expect(() => {
      result = pass.encodeAndSubmit(source, 640, 480, { threshold: 0.04 }, false);
    }).not.toThrow();

    expect(result).toBeNull();
    // The broken buffer is never finished/submitted — it simply never reaches
    // the queue, so it cannot take anything else down with it.
    expect(submit).not.toHaveBeenCalled();
    expect(pass.getFieldTexture()).toBeNull();
  });

  it('does not throw and declines cleanly when only the flow dispatch fails', () => {
    const { device, submit } = fakeDevice();
    encodeMotionFieldInto.mockReturnValue({
      kind: 'gpu-motion-field',
      fieldTexture,
      width: 160,
      height: 120,
      hasFlow: false,
    });
    encodeMotionFlowInto.mockImplementation(() => {
      throw new Error('Validation error: storage texture format mismatch');
    });

    const pass = new MotionFieldPass(device);
    let result: GPUTexture | null = null;
    expect(() => {
      result = pass.encodeAndSubmit(source, 640, 480, { threshold: 0.04 }, true);
    }).not.toThrow();

    expect(result).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(pass.getFieldTexture()).toBeNull();
  });

  it('declines without creating an encoder when the backend is unsupported', () => {
    isSupported.mockReturnValue(false);
    const { device, createCommandEncoder } = fakeDevice();

    const pass = new MotionFieldPass(device);
    const result = pass.encodeAndSubmit(source, 640, 480, { threshold: 0.04 }, false);

    expect(result).toBeNull();
    expect(createCommandEncoder).not.toHaveBeenCalled();
  });
});
