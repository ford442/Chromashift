import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructed = vi.fn<(device: GPUDevice) => void>();
const destroyed = vi.fn<(device: GPUDevice) => void>();

vi.mock('./chores', () => ({
  WebGpuChoreBackend: class {
    device: GPUDevice;

    constructor(device: GPUDevice) {
      this.device = device;
      constructed(device);
    }

    destroy(): void {
      destroyed(this.device);
    }
  },
}));

const {
  acquireGpuChoreSession,
  gpuChoreBackendsConstructed,
  gpuChoreSessionRefCount,
  resetGpuChoreSessionStatsForTests,
} = await import('./GpuChoreSession');

/** Identity is all the registry needs — no real device is constructed here. */
function fakeDevice(label: string): GPUDevice {
  return { label } as unknown as GPUDevice;
}

describe('GpuChoreSession', () => {
  beforeEach(() => {
    constructed.mockClear();
    destroyed.mockClear();
    resetGpuChoreSessionStatsForTests();
  });

  it('constructs exactly one backend for analysis + coincidence + motion-field', () => {
    const device = fakeDevice('shared');

    // The three lanes that used to build a backend each: GpuImageAnalysis,
    // PersistencePass (coincidence), MotionFieldPass (motion-field).
    const analysis = acquireGpuChoreSession(device);
    const coincidence = acquireGpuChoreSession(device);
    const motion = acquireGpuChoreSession(device);

    expect(gpuChoreBackendsConstructed()).toBe(1);
    expect(constructed).toHaveBeenCalledTimes(1);
    expect(analysis.backend).toBe(coincidence.backend);
    expect(coincidence.backend).toBe(motion.backend);
    expect(gpuChoreSessionRefCount(device)).toBe(3);

    analysis.release();
    coincidence.release();
    motion.release();
  });

  it('keeps the backend alive until the last lease is released', () => {
    const device = fakeDevice('refcount');
    const orchestrator = acquireGpuChoreSession(device);
    const persistence = acquireGpuChoreSession(device);

    // Tearing down PersistencePass must not pull the backend out from under
    // analysis — that coupling is the thing ref-counting exists to prevent.
    persistence.release();
    expect(destroyed).not.toHaveBeenCalled();
    expect(gpuChoreSessionRefCount(device)).toBe(1);

    orchestrator.release();
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(gpuChoreSessionRefCount(device)).toBe(0);
  });

  it('treats a repeated release as a no-op', () => {
    const device = fakeDevice('double-release');
    const first = acquireGpuChoreSession(device);
    const second = acquireGpuChoreSession(device);

    first.release();
    first.release();

    // A double teardown must not have dropped the count to zero early.
    expect(destroyed).not.toHaveBeenCalled();
    expect(gpuChoreSessionRefCount(device)).toBe(1);

    second.release();
    expect(destroyed).toHaveBeenCalledTimes(1);
  });

  it('builds a separate backend per device', () => {
    const a = acquireGpuChoreSession(fakeDevice('a'));
    const b = acquireGpuChoreSession(fakeDevice('b'));

    expect(gpuChoreBackendsConstructed()).toBe(2);
    expect(a.backend).not.toBe(b.backend);

    a.release();
    b.release();
  });

  it('rebuilds after the last release rather than handing back a destroyed backend', () => {
    const device = fakeDevice('reacquire');
    const first = acquireGpuChoreSession(device);
    const firstBackend = first.backend;
    first.release();

    const second = acquireGpuChoreSession(device);
    expect(gpuChoreBackendsConstructed()).toBe(2);
    expect(second.backend).not.toBe(firstBackend);
    second.release();
  });
});
