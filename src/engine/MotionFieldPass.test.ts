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

describe('MotionFieldPass CPU fallback', () => {
  beforeEach(() => {
    isSupported.mockReturnValue(false);
    vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, COPY_DST: 2 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    isSupported.mockReturnValue(true);
  });

  function cpuDevice() {
    const textures: { width: number; height: number; destroy: ReturnType<typeof vi.fn> }[] = [];
    const createTexture = vi.fn((desc: GPUTextureDescriptor) => {
      const [width, height] = desc.size as number[];
      const texture = { width, height, format: desc.format, destroy: vi.fn() };
      textures.push(texture);
      return texture;
    });
    const writeTexture = vi.fn();
    const device = {
      createCommandEncoder: vi.fn(),
      createTexture,
      queue: { submit: vi.fn(), writeTexture },
    } as unknown as GPUDevice;
    return { device, createTexture, writeTexture, textures };
  }

  it('wants a CPU field only when the GPU lane cannot serve one', () => {
    const { device } = cpuDevice();
    expect(new MotionFieldPass(device).wantsCpuField()).toBe(true);
    isSupported.mockReturnValue(true);
    expect(new MotionFieldPass(device).wantsCpuField()).toBe(false);
  });

  it('serves the uploaded rgba16float field on decline, with flow', () => {
    const { device, createTexture, writeTexture } = cpuDevice();
    const pass = new MotionFieldPass(device);
    pass.setCpuField({
      field: new Float32Array([1, 0.5]),
      flow: new Float32Array([1, -2, 0, 0]),
      width: 2,
      height: 1,
    });

    expect(createTexture).toHaveBeenCalledWith(expect.objectContaining({ format: 'rgba16float' }));
    const [, data, layout] = writeTexture.mock.calls[0];
    expect(Array.from(data as Uint16Array)).toEqual([0x3c00, 0x3c00, 0xc000, 0x3c00, 0x3800, 0, 0, 0x3c00]);
    expect(layout).toEqual({ bytesPerRow: 16, rowsPerImage: 1 });

    const result = pass.encodeAndSubmit(source, 640, 480, { threshold: 0.04 }, true);
    expect(result).toBe(createTexture.mock.results[0].value);
    expect(pass.hasFlowField()).toBe(true);
  });

  it('reuses the texture at the same size and drops it on null', () => {
    const { device, createTexture, textures } = cpuDevice();
    const pass = new MotionFieldPass(device);
    const motion = { field: new Float32Array(4), width: 2, height: 2 };
    pass.setCpuField(motion);
    pass.setCpuField(motion);
    expect(createTexture).toHaveBeenCalledTimes(1);
    expect(pass.encodeAndSubmit(source, 640, 480, { threshold: 0.04 }, false)).not.toBeNull();
    expect(pass.hasFlowField()).toBe(false);

    pass.setCpuField(null);
    expect(textures[0].destroy).toHaveBeenCalled();
    expect(pass.encodeAndSubmit(source, 640, 480, { threshold: 0.04 }, false)).toBeNull();
  });
});
