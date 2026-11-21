import { describe, expect, it, vi } from 'vitest';
import {
  isFatalGpuDeviceRequestError,
  withErrorScope,
  attachDeviceDiagnostics,
  toBootstrapRuntimeError,
  deviceLostRuntimeError,
  simulateDeviceLoss,
  recordUncapturedGpuError,
  resetGpuFatalForTests,
} from './gpuErrors';
import { readDiagnostic } from '../diagnostics';

/** A device that is never lost unless the test resolves `lose`. */
function liveDevice(features: string[] = []): GPUDevice & { lose: (info: GPUDeviceLostInfo) => void } {
  let lose!: (info: GPUDeviceLostInfo) => void;
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => { lose = resolve; });
  return { features: new Set(features), lost, lose } as unknown as GPUDevice & {
    lose: (info: GPUDeviceLostInfo) => void;
  };
}

describe('withErrorScope', () => {
  function scopedDevice(errorOnPop: GPUError | null) {
    const pops = vi.fn(async () => errorOnPop);
    const device = { pushErrorScope: vi.fn(), popErrorScope: pops } as unknown as GPUDevice;
    return { device, pops };
  }

  it('pops its scope once when the scope caught an error', async () => {
    const { device, pops } = scopedDevice({ message: 'invalid pipeline' } as GPUError);
    await expect(withErrorScope(device, 'validation', 'test', () => 1)).rejects.toThrow(/invalid pipeline/);
    // A second pop would take the enclosing caller's scope.
    expect(pops).toHaveBeenCalledTimes(1);
  });

  it('pops its scope once when the work throws', async () => {
    const { device, pops } = scopedDevice(null);
    await expect(withErrorScope(device, 'validation', 'test', () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(pops).toHaveBeenCalledTimes(1);
  });

  it('pops once and returns the result on success', async () => {
    const { device, pops } = scopedDevice(null);
    await expect(withErrorScope(device, 'validation', 'test', () => 7)).resolves.toBe(7);
    expect(pops).toHaveBeenCalledTimes(1);
  });
});

describe('attachDeviceDiagnostics', () => {
  it('stops forwarding device.lost once detached', async () => {
    const device = Object.assign(liveDevice(), { onuncapturederror: null });
    const stale = vi.fn();
    const live = vi.fn();
    const detach = attachDeviceDiagnostics(device, { onLost: stale });
    attachDeviceDiagnostics(device, { onLost: live });
    detach();

    device.lose({ reason: 'unknown', message: 'reset' } as GPUDeviceLostInfo);
    await Promise.resolve();
    await Promise.resolve();

    expect(stale).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledOnce();
  });
});

describe('attachDeviceDiagnostics uncaptured errors', () => {
  /** A device whose `uncapturederror` is a real event target. */
  function eventDevice() {
    const target = new EventTarget();
    const device = Object.assign(liveDevice(), {
      onuncapturederror: null,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    });
    const fire = (message: string) => {
      const event = new Event('uncapturederror');
      Object.assign(event, { error: { message } });
      target.dispatchEvent(event);
    };
    return { device, fire };
  }

  it('keeps every live handler when detaches happen out of order', () => {
    const { device, fire } = eventDevice();
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();
    const detachFirst = attachDeviceDiagnostics(device, { onUncapturedError: first });
    attachDeviceDiagnostics(device, { onUncapturedError: second });
    const detachThird = attachDeviceDiagnostics(device, { onUncapturedError: third });
    // Not LIFO: the old chain restored `previous` here and dropped `second`.
    detachFirst();
    detachThird();

    fire('invalid bind group');

    expect(first).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ message: 'invalid bind group' });
    expect(device.onuncapturederror).toBeNull();
  });

  it('counts uncaptured errors in the breadcrumbs', () => {
    vi.stubGlobal('window', {});
    resetGpuFatalForTests();
    recordUncapturedGpuError({ message: 'a' } as GPUError);
    recordUncapturedGpuError({ message: 'b' } as GPUError);
    expect(readDiagnostic('gpuUncapturedErrors')).toBe(2);
    expect(readDiagnostic('gpuLastUncapturedError')).toBe('b');
    resetGpuFatalForTests();
    vi.unstubAllGlobals();
  });
});

describe('simulateDeviceLoss', () => {
  it('destroys the device and reports an unexplained loss to its attached listeners', () => {
    const destroy = vi.fn();
    const device = Object.assign(liveDevice(), { onuncapturederror: null, destroy });
    const stale = vi.fn();
    const live = vi.fn();
    const detach = attachDeviceDiagnostics(device, { onLost: stale });
    attachDeviceDiagnostics(device, { onLost: live });
    detach();

    simulateDeviceLoss(device, 'e2e reset');

    expect(destroy).toHaveBeenCalledOnce();
    // Synchronously, and as `unknown`: `destroyed` is the app's own doing, which it ignores.
    expect(live).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unknown', message: 'e2e reset' }));
    expect(stale).not.toHaveBeenCalled();
  });
});

describe('runtime error helpers', () => {
  it('marks queue-create OOM as a non-recoverable bootstrap failure', () => {
    const err = toBootstrapRuntimeError(
      new Error("Failed to execute 'requestDevice' on 'GPUAdapter': D3D12 create command queue failed with E_OUTOFMEMORY (0x8007000E)"),
    );
    expect(err.kind).toBe('bootstrap');
    expect(err.recoverable).toBe(false);
    expect(err.message).toContain('out of memory');
    expect(err.detail).toContain('E_OUTOFMEMORY');
  });

  it('marks other bootstrap failures as non-recoverable', () => {
    const err = toBootstrapRuntimeError(new Error('No adapter'));
    expect(err.kind).toBe('bootstrap');
    expect(err.recoverable).toBe(false);
  });

  it('detects D3D12 queue OOM text', () => {
    expect(isFatalGpuDeviceRequestError(new Error('create command queue failed with E_OUTOFMEMORY'))).toBe(true);
    expect(isFatalGpuDeviceRequestError(new Error('no adapter available'))).toBe(false);
  });

  it('formats device loss with detail', () => {
    const err = deviceLostRuntimeError({ reason: 'unknown', message: 'reset' } as GPUDeviceLostInfo);
    expect(err.kind).toBe('device-lost');
    expect(err.recoverable).toBe(true);
    expect(err.detail).toContain('reset');
  });
});
