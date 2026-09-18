import { buildGraphPreset, isGraphPresetName, type GraphPresetName } from './altGraphs';
import { compileGraph, graphCompileCount } from './compile';
import { PassGraphError } from './errors';
import type { CompiledGraph, GraphBackend } from './types';

const STORAGE_KEY = 'chromashift.passGraph';

declare global {
  interface Window {
    /** True when the pass-graph compiler ran for this session. */
    passGraphActive?: boolean;
    /** Compilations so far — must not move when a parameter changes. */
    passGraphCompileCount?: number;
    /** Scheduled pass order, for E2E assertions. */
    passGraphPasses?: string[];
    /** Pool slot count per resolution class. */
    passGraphSlots?: Record<string, number>;
    /** Set when compilation refused the graph, naming the node. */
    passGraphError?: string | null;
    /** Which named graph shape the gate selected. */
    passGraphName?: GraphPresetName | null;
    /** Name of the graph a GPU executor is drawing, or `null` for the hand encoder. */
    passGraphExecuting?: GraphPresetName | null;
    /**
     * Node ids the executor actually encodes, in order. Shorter than
     * `passGraphPasses`: `source` and `output` own no pass, and a `coincidence`
     * fused into its `decay` consumers is absorbed by them.
     */
    passGraphExecutedPasses?: string[];
  }
}

/** Selection the gate resolved from the URL or the stored preference. */
export interface PassGraphSelection {
  enabled: boolean;
  name: GraphPresetName;
}

/**
 * Pass-graph gate.
 *
 * `?graph=1` compiles the default graph and, on WebGPU, hands it to the
 * `GraphExecutor` that draws it. `?graph=blur` / `?graph=warp` select a
 * different *shape* — a graph the hand-written encoder cannot express — and
 * `?graph=0` forces the hand encoder. The WebGL diagnostic backend compiles but
 * does not execute, so it stays on the hand encoder either way.
 */
export function passGraphSelection(search?: string): PassGraphSelection {
  const off: PassGraphSelection = { enabled: false, name: 'default' };
  try {
    const params = new URLSearchParams(search ?? window.location.search);
    const explicit = params.get('graph');
    if (explicit !== null) {
      if (explicit === '0' || explicit === 'false') return off;
      if (isGraphPresetName(explicit)) return { enabled: true, name: explicit };
      return { enabled: true, name: 'default' };
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null || stored === '0') return off;
    return { enabled: true, name: isGraphPresetName(stored) ? stored : 'default' };
  } catch {
    return off;
  }
}

export function passGraphRequested(search?: string): boolean {
  return passGraphSelection(search).enabled;
}

export function setStoredPassGraphPreference(enabled: boolean | GraphPresetName): void {
  try {
    const value = enabled === false ? '0' : enabled === true ? '1' : enabled;
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage can be disabled in hardened test browsers.
  }
}

/**
 * Compile the selected graph for `backend` and publish the breadcrumbs.
 *
 * Returns the compiled graph, or `null` when the gate is off or compilation
 * refused the graph — the refusal is published rather than swallowed.
 */
export function activatePassGraph(
  backend: GraphBackend,
  layerCount?: number,
): CompiledGraph | null {
  const selection = passGraphSelection();
  if (!selection.enabled) {
    publish(false, null, null, null);
    return null;
  }

  try {
    const compiled = compileGraph(buildGraphPreset(selection.name, layerCount), backend);
    publish(true, compiled, null, selection.name);
    return compiled;
  } catch (error) {
    const message = error instanceof PassGraphError
      ? `${error.code}: ${error.message}`
      : String(error);
    console.warn('[Chromashift:PassGraph] refused to compile the graph —', message);
    publish(true, null, message, selection.name);
    return null;
  }
}

/**
 * Record that a GPU executor adopted (or dropped) the compiled graph.
 *
 * `passGraphActive` says the compiler ran; this says something is *drawing*
 * what it produced. Keeping them separate is what makes "Phase 1 shipped dark"
 * and "Phase 2 draws" distinguishable from a test.
 */
export function publishGraphExecutorBreadcrumbs(
  name: GraphPresetName | null,
  encodedPasses: string[],
): void {
  if (typeof window === 'undefined') return;
  window.passGraphExecuting = name;
  window.passGraphExecutedPasses = encodedPasses;
}

function publish(
  active: boolean,
  compiled: CompiledGraph | null,
  error: string | null,
  name: GraphPresetName | null,
): void {
  if (typeof window === 'undefined') return;
  window.passGraphActive = active;
  window.passGraphCompileCount = graphCompileCount();
  window.passGraphPasses = compiled ? compiled.passes.map((pass) => pass.nodeId) : [];
  window.passGraphSlots = compiled ? { ...compiled.allocation.slotsByResolution } : {};
  window.passGraphError = error;
  window.passGraphName = name;
  if (!compiled) publishGraphExecutorBreadcrumbs(null, []);
}
