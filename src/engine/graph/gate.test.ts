import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activatePassGraph,
  passGraphSelection,
  publishGraphExecutorBreadcrumbs,
  buildDefaultGraph,
  compileGraph,
  graphCompileCount,
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

describe('?graph gate', () => {
  it('draws the default graph with no ?graph and no preference', () => {
    installBrowserGlobals('');
    expect(passGraphSelection()).toEqual({ name: 'default' });
  });

  it.each(['?graph=0', '?graph=false'])('reads the retired opt-out %s as the default graph', (search) => {
    // `?graph=0` selected the hand encoder for the release it outlived the
    // flip; with the hand encoder gone it draws the default graph, and says so.
    installBrowserGlobals(search);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(passGraphSelection()).toEqual({ name: 'default' });
    warn.mockRestore();
  });

  it('falls back to the stored preference', () => {
    const win = installBrowserGlobals('');
    setStoredPassGraphPreference('trails3');
    expect(win.localStorage.getItem(STORAGE_KEY)).toBe('trails3');
    expect(passGraphSelection()).toEqual({ name: 'trails3' });

    setStoredPassGraphPreference(null);
    expect(win.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(passGraphSelection()).toEqual({ name: 'default' });
  });

  it('lets the URL override the stored preference', () => {
    installBrowserGlobals('?graph=blur');
    setStoredPassGraphPreference('trails3');
    expect(passGraphSelection()).toEqual({ name: 'blur' });
  });

  it('reads an unusable localStorage as no preference', () => {
    vi.stubGlobal('window', {
      location: { search: '' },
      get localStorage(): Storage { throw new Error('blocked'); },
    });
    expect(passGraphSelection()).toEqual({ name: 'default' });
  });
});

describe('named graph shapes', () => {
  it.each([
    ['?graph=1', 'default'],
    ['?graph=default', 'default'],
    ['?graph=blur', 'blur'],
    ['?graph=warp', 'warp'],
    ['?graph=smear', 'smear'],
    ['?graph=feedback', 'feedback'],
    ['?graph=trails3', 'trails3'],
    // An unrecognised name is the default graph, not a refusal: the gate's job
    // is to pick a shape, and "on with something unknown" means "on".
    ['?graph=nonsense', 'default'],
    ['', 'default'],
  ])('%s selects the %s graph', (search, name) => {
    installBrowserGlobals(search);
    expect(passGraphSelection()).toEqual({ name });
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

  it('refuses the body-smear starter on WebGL, naming its history node', () => {
    const win = installBrowserGlobals('?graph=smear');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(activatePassGraph('webgl')).toBeNull();
    expect(win.passGraphError).toMatch(/^unsupported-node: /);
    expect(win.passGraphError).toContain("'history'");
    expect(win.passGraphError).toContain("'smear-history'");
    expect(win.passGraphRingFrames).toEqual({});
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
  it('compiles the default graph with no ?graph at all', () => {
    const win = installBrowserGlobals('');
    expect(activatePassGraph('webgpu')).not.toBeNull();
    expect(win.passGraphActive).toBe(true);
    expect(win.passGraphName).toBe('default');
    expect(graphCompileCount()).toBe(1);
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
    expect(win.passGraphRingFrames).toEqual({ source: 0, layer: 0, tracer: 0, output: 0 });
  });

  it('reports the body-smear ring beside the pool slots', () => {
    const win = installBrowserGlobals('?graph=smear');
    const compiled = activatePassGraph('webgpu');

    expect(win.passGraphError).toBeNull();
    expect(win.passGraphPasses).toEqual(expect.arrayContaining(['smear-history', 'smear-displace']));
    expect(win.passGraphRingFrames).toEqual({ source: 0, layer: 4, tracer: 0, output: 0 });
    expect(compiled!.allocation.rings).toHaveLength(1);
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
