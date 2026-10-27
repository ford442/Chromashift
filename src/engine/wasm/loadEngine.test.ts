import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWasmEngineStatus, isWasmSimdSupported, leb128, loadWasmEngine } from './loadEngine';

describe('isWasmSimdSupported', () => {
  // Node has had WebAssembly SIMD128 since v16, so the probe module must
  // validate here. When its section sizes were wrong, validate() returned false
  // in every runtime and the WASM engine silently never loaded in any browser.
  it('accepts a runtime that supports SIMD128', () => {
    expect(isWasmSimdSupported()).toBe(true);
  });
});

describe('leb128', () => {
  it('encodes the probe-sized lengths in one byte', () => {
    expect(leb128(0)).toEqual([0x00]);
    expect(leb128(20)).toEqual([0x14]);
    expect(leb128(22)).toEqual([0x16]);
    expect(leb128(127)).toEqual([0x7f]);
  });

  it('continues past seven bits', () => {
    expect(leb128(128)).toEqual([0x80, 0x01]);
    expect(leb128(624485)).toEqual([0xe5, 0x8e, 0x26]);
  });
});

describe('loadWasmEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Node has no `location`, so building the glue URL throws — standing in for
  // any fetch/import/instantiate failure. It used to vanish into a bare
  // `catch {}` reported as "assets not built".
  it('reports a failed load as `error` with its cause, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadWasmEngine()).toBe(false);

    const status = getWasmEngineStatus();
    expect(status.state).toBe('error');
    expect(status.error).toMatch(/\S/);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to load'),
      expect.anything(),
    );
    // Settled: a second call answers from the cached state.
    expect(await loadWasmEngine()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
