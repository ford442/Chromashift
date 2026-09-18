import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activatePassGraph,
  passGraphSelection,
  publishGraphExecutorBreadcrumbs,
  buildDefaultGraph,
  compileGraph,
  graphCompileCount,
  passGraphRequested,
  resetGraphCompileCache,
  setStoredPassGraphPreference,
} from './index';

const STORAGE_KEY = 'chromashift.passGraph';

function installBrowserGlobals(search = '') {
  const storage = new Map<string, string>();
  const win = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
      clear: () => { storage.clear(); },
    },
    location: { search, href: `http://localhost:5173/${search}` },
  } as unknown as Window & typeof globalThis;

  vi.stubGlobal('window', win);
  vi.stubGlobal('localStorage', win.localStorage);
  return win;
}

beforeEach(() => {
  resetGraphCompileCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('?graph=1 gate', () => {
  it('is off by default', () => {
    installBrowserGlobals('');
    expect(passGraphRequested()).toBe(false);
  });

  it.each(['?graph=1', '?graph', '?renderer=webgl&graph=1'])('is on for %s', (search) => {
    installBrowserGlobals(search);
    expect(passGraphRequested()).toBe(true);
  });

  it.each(['?graph=0', '?graph=false'])('stays off for %s', (search) => {
    installBrowserGlobals(search);
    expect(passGraphRequested()).toBe(false);
  });

  it('falls back to the stored preference', () => {
    const win = installBrowserGlobals('');
    setStoredPassGraphPreference(true);
    expect(win.localStorage.getItem(STORAGE_KEY)).toBe('1');
    expect(passGraphRequested()).toBe(true);

    setStoredPassGraphPreference(false);
    expect(passGraphRequested()).toBe(false);
  });

  it('survives an unusable localStorage', () => {
    vi.stubGlobal('window', {
      location: { search: '' },
      get localStorage(): Storage { throw new Error('blocked'); },
    });
    expect(passGraphRequested()).toBe(false);
  });
});

describe('named graph shapes', () => {
  it.each([
    ['?graph=1', 'default'],
    ['?graph=default', 'default'],
    ['?graph=blur', 'blur'],
    ['?graph=warp', 'warp'],
    // An unrecognised name is the default graph, not a refusal: the gate's job
    // is to pick a shape, and "on with something unknown" means "on".
    ['?graph=nonsense', 'default'],
  ])('%s selects the %s graph', (search, name) => {
    installBrowserGlobals(search);
    expect(passGraphSelection()).toEqual({ enabled: true, name });
  });

  it('compiles the selected shape and names it', () => {
    const win = installBrowserGlobals('?graph=blur');
    const compiled = activatePassGraph('webgpu');
    expect(win.passGraphName).toBe('blur');
    expect(compiled!.passes.map((pass) => pass.nodeId)).toContain('layer0-blur-x');
  });

  it('refuses a warp graph on the WebGL diagnostic backend, naming the node', () => {
    const win = installBrowserGlobals('?graph=warp');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(activatePassGraph('webgl')).toBeNull();
    expect(win.passGraphError).toContain('unsupported-node');
    expect(win.passGraphError).toContain("'warp'");
    expect(win.passGraphExecuting).toBeNull();
    warn.mockRestore();
  });

  it('separates "the compiler ran" from "something is drawing it"', () => {
    const win = installBrowserGlobals('?graph=1');
    activatePassGraph('webgpu');
    expect(win.passGraphActive).toBe(true);
    expect(win.passGraphExecuting ?? null).toBeNull();

    publishGraphExecutorBreadcrumbs('default', ['layer0', 'composite']);
    expect(win.passGraphExecuting).toBe('default');
    expect(win.passGraphExecutedPasses).toEqual(['layer0', 'composite']);
  });
});

describe('breadcrumbs', () => {
  it('reports inactive without compiling anything', () => {
    const win = installBrowserGlobals('');
    expect(activatePassGraph('webgpu')).toBeNull();
    expect(win.passGraphActive).toBe(false);
    expect(win.passGraphPasses).toEqual([]);
    expect(graphCompileCount()).toBe(0);
  });

  it('publishes the compiled pass order and pool slots when gated on', () => {
    const win = installBrowserGlobals('?graph=1');
    const compiled = activatePassGraph('webgpu');

    expect(compiled).not.toBeNull();
    expect(win.passGraphActive).toBe(true);
    expect(win.passGraphError).toBeNull();
    expect(win.passGraphCompileCount).toBe(1);
    expect(win.passGraphPasses).toEqual(compiled!.passes.map((pass) => pass.nodeId));
    expect(win.passGraphSlots).toEqual({ source: 0, layer: 3, tracer: 3, output: 0 });
  });

  it('holds the compile counter steady when only a parameter changes', () => {
    const win = installBrowserGlobals('?graph=1');
    activatePassGraph('webgpu');
    expect(win.passGraphCompileCount).toBe(1);

    // A slider move is a parameter change, not a topology change.
    const tweaked = buildDefaultGraph();
    tweaked.nodes.find((n) => n.kind === 'decay')!.params.durationMs = 7777;
    compileGraph(tweaked, 'webgpu');

    activatePassGraph('webgpu');
    expect(win.passGraphCompileCount).toBe(1);
  });

  it('publishes a named refusal instead of throwing', () => {
    const win = installBrowserGlobals('?graph=1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 11 layers exceeds the canonical band table, so the graph is refused.
    expect(activatePassGraph('webgl', 11)).toBeNull();
    expect(win.passGraphActive).toBe(true);
    expect(win.passGraphError).toContain('11');
    warn.mockRestore();
  });
});
