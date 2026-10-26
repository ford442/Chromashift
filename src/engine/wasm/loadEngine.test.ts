import { describe, expect, it } from 'vitest';
import { isWasmSimdSupported } from './loadEngine';

describe('isWasmSimdSupported', () => {
  // Node has had WebAssembly SIMD128 since v16, so the probe module must
  // validate here. When its section sizes were wrong, validate() returned false
  // in every runtime and the WASM engine silently never loaded in any browser.
  it('accepts a runtime that supports SIMD128', () => {
    expect(isWasmSimdSupported()).toBe(true);
  });
});
