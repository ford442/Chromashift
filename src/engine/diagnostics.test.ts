import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTIC_KEYS,
  publishDiagnostic,
  publishDiagnostics,
  readDiagnostic,
  readDiagnostics,
  resetDiagnosticsForTests,
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
