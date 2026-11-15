import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTIC_KEYS,
  applyForwardedDiagnostics,
  forwardDiagnostics,
  publishDiagnostic,
  publishDiagnostics,
  readDiagnostic,
  publishWorkerWasmEngine,
  readDiagnostics,
  resendForwardedDiagnostics,
  resetDiagnosticsForTests,
  type ChromashiftDiagnostics,
} from './diagnostics';

describe('diagnostics registry', () => {
  afterEach(() => {
    resetDiagnosticsForTests();
    vi.unstubAllGlobals();
  });

  it('is a no-op without a window (Node, workers)', () => {
    expect(typeof window).toBe('undefined');
    publishDiagnostic('kioskMode', true);
    publishDiagnostics({ usingWebGL: true });
    expect(readDiagnostic('kioskMode')).toBeUndefined();
    expect(readDiagnostics()).toEqual({});
  });

  it('writes through to window[key], where devtools and E2E read it', () => {
    const fakeWindow: Record<string, unknown> = {};
    vi.stubGlobal('window', fakeWindow);
    publishDiagnostic('motionFieldEnergy', 0.25);
    publishDiagnostics({ rendererType: 'webgl', usingWebGL: true, usingWebGPU: false });
    expect(fakeWindow.motionFieldEnergy).toBe(0.25);
    expect(fakeWindow.rendererType).toBe('webgl');
    expect(readDiagnostic('usingWebGL')).toBe(true);
  });

  it('snapshots only what has been published, and reset forgets it', () => {
    const fakeWindow: Record<string, unknown> = { unrelated: 1 };
    vi.stubGlobal('window', fakeWindow);
    publishDiagnostics({ compareLayout: 'quad', compareSwipePosition: 0.5 });
    expect(readDiagnostics()).toEqual({ compareLayout: 'quad', compareSwipePosition: 0.5 });
    resetDiagnosticsForTests();
    expect(readDiagnostics()).toEqual({});
    expect(fakeWindow.unrelated).toBe(1);
  });

  it('lists every key once', () => {
    expect(new Set(DIAGNOSTIC_KEYS).size).toBe(DIAGNOSTIC_KEYS.length);
  });
});

/** Every `.ts`/`.tsx` under `src/`, tests excluded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('breadcrumbs go through the registry', () => {
  const srcRoot = join(__dirname, '..');
  const files = sourceFiles(srcRoot).filter((file) => !file.endsWith(join('engine', 'diagnostics.ts')));

  it('no module casts window to add its own fields', () => {
    const offenders = files.filter((file) => /\bwindow as (Window\b|\w+Window\b)/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(srcRoot, file))).toEqual([]);
  });

  it('no module assigns a breadcrumb on window directly', () => {
    const assignment = new RegExp(`\\bwindow\\.(${DIAGNOSTIC_KEYS.join('|')})\\s*(=[^=]|\\?\\?=)`);
    const offenders = files.filter((file) => assignment.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(srcRoot, file))).toEqual([]);
  });

  it('no module declares its own Window fields', () => {
    const offenders = files.filter((file) => /declare global\s*{[^}]*interface Window/s.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(srcRoot, file))).toEqual([]);
  });
});

describe('forwarding from a realm without a window (#253)', () => {
  afterEach(() => {
    forwardDiagnostics(null);
    vi.unstubAllGlobals();
  });

  function forwarded() {
    const batches: Partial<ChromashiftDiagnostics>[] = [];
    forwardDiagnostics((values) => batches.push(values));
    return batches;
  }

  it('mirrors the realm’s breadcrumbs, so readDiagnostic answers in a worker', () => {
    forwarded();
    publishDiagnostic('passGraphExecuting', 'default');
    expect(readDiagnostic('passGraphExecuting')).toBe('default');
  });

  it('sends one batch per task, however many breadcrumbs the task published', async () => {
    const batches = forwarded();
    publishDiagnostic('usingWebGPU', true);
    publishDiagnostics({ rendererType: 'webgpu', passGraphExecuting: 'default' });
    expect(batches).toEqual([]);
    await Promise.resolve();
    expect(batches).toEqual([{ usingWebGPU: true, rendererType: 'webgpu', passGraphExecuting: 'default' }]);
  });

  it('skips a primitive that has not changed, but always sends an object', async () => {
    const batches = forwarded();
    const passes = ['layer0'];
    publishDiagnostics({ usingWebGPU: true, passGraphPasses: passes });
    await Promise.resolve();
    publishDiagnostics({ usingWebGPU: true, passGraphPasses: passes });
    await Promise.resolve();
    publishDiagnostic('usingWebGPU', false);
    await Promise.resolve();
    expect(batches).toEqual([
      { usingWebGPU: true, passGraphPasses: ['layer0'] },
      { passGraphPasses: ['layer0'] },
      { usingWebGPU: false },
    ]);
  });

  it('after a resend, sends every key again even if unchanged (a page may have cleared its copy)', async () => {
    const batches = forwarded();
    publishDiagnostic('passGraphExecuting', 'default');
    await Promise.resolve();
    resendForwardedDiagnostics();
    publishDiagnostic('passGraphExecuting', 'default');
    await Promise.resolve();
    expect(batches).toEqual([{ passGraphExecuting: 'default' }, { passGraphExecuting: 'default' }]);
  });

  it('forwards a worker’s engine status as its own entry', async () => {
    const batches = forwarded();
    const status = { state: 'ready' } as unknown as ChromashiftDiagnostics['wasmEngineWorkers']['analysis'];
    publishWorkerWasmEngine('analysis', status!);
    await Promise.resolve();
    expect(batches).toEqual([{ wasmEngineWorkers: { analysis: status } }]);
  });

  it('is ignored on a page, whose breadcrumbs are window’s own', async () => {
    const fakeWindow: Record<string, unknown> = {};
    vi.stubGlobal('window', fakeWindow);
    const batches = forwarded();
    publishDiagnostic('kioskMode', true);
    await Promise.resolve();
    expect(batches).toEqual([]);
    expect(fakeWindow.kioskMode).toBe(true);
  });

  it('the page applies a batch to window, merging the per-worker engine record', () => {
    const page: Record<string, unknown> = { wasmEngineWorkers: { motion: { state: 'loading' } } };
    vi.stubGlobal('window', page);
    applyForwardedDiagnostics({
      renderTransport: 'worker',
      wasmEngineWorkers: { analysis: { state: 'ready' } } as unknown as ChromashiftDiagnostics['wasmEngineWorkers'],
    });
    expect(page.renderTransport).toBe('worker');
    expect(page.wasmEngineWorkers).toEqual({ motion: { state: 'loading' }, analysis: { state: 'ready' } });
  });
});
