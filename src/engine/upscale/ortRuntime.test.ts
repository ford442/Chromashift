import { describe, expect, it } from 'vitest';
import { resolveOrtWasmBase } from './ortRuntime';

describe('resolveOrtWasmBase', () => {
  it('pins the CDN copy to the bundled package version', () => {
    expect(resolveOrtWasmBase(undefined, '1.26.0')).toBe('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist');
  });

  it('prefers an explicit override and drops its trailing slashes', () => {
    expect(resolveOrtWasmBase('https://mirror.example/ort//', '1.26.0')).toBe('https://mirror.example/ort');
  });

  it('treats a blank override as unset', () => {
    expect(resolveOrtWasmBase('  ', '1.26.0')).toContain('onnxruntime-web@1.26.0');
  });

  it('refuses to guess a version it does not know', () => {
    expect(() => resolveOrtWasmBase(undefined, undefined)).toThrow(/version unknown/);
  });
});
