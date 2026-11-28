import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBuildInfo, installBuildInfo } from './buildInfo';
import { readDiagnostic, resetDiagnosticsForTests } from './engine/diagnostics';

describe('build stamp', () => {
  afterEach(() => {
    resetDiagnosticsForTests();
    vi.unstubAllGlobals();
  });

  it('reports an explicitly unstamped, dirty build when Vite did not define it', () => {
    expect(getBuildInfo()).toEqual({ sha: 'unknown', dirty: true, builtAt: '1970-01-01T00:00:00.000Z' });
  });

  it('publishes a frozen copy as window.chromashiftBuild', () => {
    const fakeWindow: Record<string, unknown> = {};
    vi.stubGlobal('window', fakeWindow);
    const info = installBuildInfo();
    expect(fakeWindow.chromashiftBuild).toBe(info);
    expect(readDiagnostic('chromashiftBuild')).toBe(info);
    expect(Object.isFrozen(info)).toBe(true);
    expect(info).toEqual(getBuildInfo());
  });
});
