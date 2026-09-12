import { compileGraph, graphCompileCount } from './compile';
import { buildDefaultGraph } from './defaultGraph';
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
  }
}

/**
 * Pass-graph gate.
 *
 * The IR and compiler ship dark: `?graph=1` (or a stored preference) turns on
 * compilation and the breadcrumbs below. The default graph is byte-for-byte the
 * shipped pipeline, so the gate changes what is *observable*, not what is
 * rendered — which is exactly what makes it safe to flip per session.
 */
export function passGraphRequested(search?: string): boolean {
  try {
    const params = new URLSearchParams(search ?? window.location.search);
    const explicit = params.get('graph');
    if (explicit !== null) return explicit !== '0' && explicit !== 'false';
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setStoredPassGraphPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Storage can be disabled in hardened test browsers.
  }
}

/**
 * Compile the default graph for `backend` and publish the breadcrumbs.
 *
 * Returns the compiled graph, or `null` when the gate is off or compilation
 * refused the graph — the refusal is published rather than swallowed.
 */
export function activatePassGraph(
  backend: GraphBackend,
  layerCount?: number,
): CompiledGraph | null {
  if (!passGraphRequested()) {
    publish(false, null, null);
    return null;
  }

  try {
    const compiled = compileGraph(buildDefaultGraph(layerCount), backend);
    publish(true, compiled, null);
    return compiled;
  } catch (error) {
    const message = error instanceof PassGraphError
      ? `${error.code}: ${error.message}`
      : String(error);
    console.warn('[Chromashift:PassGraph] refused to compile the graph —', message);
    publish(true, null, message);
    return null;
  }
}

function publish(
  active: boolean,
  compiled: CompiledGraph | null,
  error: string | null,
): void {
  if (typeof window === 'undefined') return;
  window.passGraphActive = active;
  window.passGraphCompileCount = graphCompileCount();
  window.passGraphPasses = compiled ? compiled.passes.map((pass) => pass.nodeId) : [];
  window.passGraphSlots = compiled ? { ...compiled.allocation.slotsByResolution } : {};
  window.passGraphError = error;
}
