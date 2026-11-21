import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWasmFeatureFloorSupported,
  leb128,
  missingWasmFeatures,
} from './loadEngine';

describe('the WebAssembly feature floor probe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Node has had WebAssembly SIMD128 since v16, so every probe module must
  // validate here. When the SIMD probe's section sizes were wrong, validate()
  // returned false in every runtime and the WASM engine silently never loaded
  // in any browser.
  it('accepts a runtime that has SIMD128, bulk memory, nontrapping float-to-int and sign extension', () => {
    expect(missingWasmFeatures()).toEqual([]);
    expect(isWasmFeatureFloorSupported()).toBe(true);
  });

  it('names the feature that is missing rather than just "unsupported"', () => {
    // memory.fill is `0xfc 0x0b`; reject exactly the module that carries it.
    vi.spyOn(WebAssembly, 'validate').mockImplementation((bytes) => {
      const view = new Uint8Array(bytes as ArrayBufferLike);
      for (let i = 0; i + 1 < view.length; i += 1) {
        if (view[i] === 0xfc && view[i + 1] === 0x0b) return false;
      }
      return true;
    });
    expect(missingWasmFeatures()).toEqual(['bulk-memory']);
    expect(isWasmFeatureFloorSupported()).toBe(false);
  });

  it('treats a throwing validate() as every feature missing', () => {
    vi.spyOn(WebAssembly, 'validate').mockImplementation(() => {
      throw new TypeError('no WebAssembly');
    });
    expect(missingWasmFeatures()).toEqual(['simd128', 'bulk-memory', 'nontrapping-fptoint', 'sign-ext']);
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
  // `loadEngine.ts` keeps its state per module instance: a fresh import per test.
  async function freshLoader() {
    vi.resetModules();
    return import('./loadEngine');
  }

  /** A glue module whose factory fails the first `failures` times it is called. */
  function flakyGlue(failures: number): { url: string; calls: () => number } {
    const key = `__wasmGlueCalls_${Math.random().toString(36).slice(2)}`;
    const source = `export default async () => {
      const n = (globalThis[${JSON.stringify(key)}] ?? 0) + 1;
      globalThis[${JSON.stringify(key)}] = n;
      if (n <= ${failures}) throw new Error('transient fetch failure ' + n);
      return { _malloc() { return 8; }, _free() {} };
    };`;
    return {
      url: `data:text/javascript,${encodeURIComponent(source)}`,
      calls: () => (globalThis as unknown as Record<string, number | undefined>)[key] ?? 0,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Under Node there is no `/chromashift_engine.js` at the filesystem root, so
  // the glue import fails — standing in for any fetch/import/instantiate
  // failure. It used to vanish into a bare `catch {}` reported as "assets not
  // built".
  it('reports a load that fails twice as `error` with its cause, and logs it', async () => {
    // Real timers: the failing import goes through the module loader, which does
    // not run under fake ones. The retry delay is a quarter of a second.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getWasmEngineStatus, loadWasmEngine } = await freshLoader();

    expect(await loadWasmEngine()).toBe(false);

    const status = getWasmEngineStatus();
    expect(status.state).toBe('error');
    expect(status.error).toMatch(/\S/);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to load'),
      expect.anything(),
    );
    // Settled: a second call answers from the cached state, with no new attempt.
    const callsBefore = warn.mock.calls.length;
    expect(await loadWasmEngine()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(callsBefore);
  });

  it('retries a transient failure once, and ends up ready', async () => {
    // Real timers: importing the stub glue goes through the module loader, which
    // does not run under fake ones. The retry delay is a quarter of a second.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { getWasmEngineStatus, getWasmModule, loadWasmEngine } = await freshLoader();
    const glue = flakyGlue(1);

    const loading = loadWasmEngine({ glueUrl: glue.url, wasmBinary: new Uint8Array(0) });
    expect(getWasmEngineStatus().state).toBe('loading');

    expect(await loading).toBe(true);
    expect(getWasmEngineStatus()).toEqual({ state: 'ready', error: null });
    expect(getWasmModule()).not.toBeNull();
    expect(glue.calls()).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('load attempt 1 of 2 failed'),
      expect.any(Error),
    );
  });

  it('gives up after the second failure rather than retrying forever', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getWasmEngineStatus, loadWasmEngine } = await freshLoader();
    const glue = flakyGlue(5);

    expect(await loadWasmEngine({ glueUrl: glue.url, wasmBinary: new Uint8Array(0) })).toBe(false);
    expect(glue.calls()).toBe(2);
    expect(getWasmEngineStatus()).toEqual({
      state: 'error',
      error: 'transient fetch failure 2',
    });
  });

  it('reports `unavailable`, naming the feature, when the runtime lacks one', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(WebAssembly, 'validate').mockImplementation((bytes) => {
      const view = new Uint8Array(bytes as ArrayBufferLike);
      return !view.includes(0xc0); // i32.extend8_s
    });
    const { getWasmEngineStatus, loadWasmEngine } = await freshLoader();

    expect(await loadWasmEngine()).toBe(false);
    expect(getWasmEngineStatus()).toEqual({
      state: 'unavailable',
      error: 'WebAssembly sign-ext not supported by this runtime',
    });
  });
});
