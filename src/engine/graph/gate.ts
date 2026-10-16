import { ringTexturesByResolution } from './allocate';
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
    /**
     * `history` ring textures per resolution class — VRAM that outlives the
     * frame and so is not in `passGraphSlots`. Empty when no graph compiled.
     */
    passGraphRingFrames?: Record<string, number>;
    /** Set when compilation refused the graph, naming the node. */
    passGraphError?: string | null;
    /** Which named graph shape the gate selected. */
    passGraphName?: GraphPresetName | null;
    /**
     * The variant of that shape a renderer last compiled for a frame
     * (`graphVariantKey`: layer count, temporal term, presentation), or `null`
     * when no renderer builds variants (the gate alone, the WebGL backend).
     */
    passGraphVariant?: string | null;
    /** Name of the graph a GPU executor is drawing, or `null` for the hand encoder. */
    passGraphExecuting?: GraphPresetName | null;
    /**
     * Node ids the executor actually encodes, in order. Shorter than
     * `passGraphPasses`: `source` and `output` own no pass, and a `coincidence`
     * fused into its `decay` consumers is absorbed by them.
     */
    passGraphExecutedPasses?: string[];
    /**
     * Per orchestrator slot (`main`, `compare-b`, the quad cells): the graph
     * shape that slot's executor is drawing, or `null` while it draws with the
     * hand encoder. Absent for a slot that has no renderer.
     */
    passGraphSlotsExecuting?: Record<string, GraphPresetName | null>;
  }
}

/** Selection the gate resolved from the URL or the stored preference. */
export interface PassGraphSelection {
  enabled: boolean;
  name: GraphPresetName;
}

/** What a session with no `?graph` and no stored preference gets. */
const DEFAULT_SELECTION: PassGraphSelection = { enabled: true, name: 'default' };
const OFF: PassGraphSelection = { enabled: false, name: 'default' };

/** A `?graph=` value (or the stored preference) as a selection. */
function selectionFor(value: string): PassGraphSelection {
  if (value === '0' || value === 'false') return OFF;
  // An unrecognised value is the default graph, not a refusal: the gate's job
  // is to pick a shape, and "on with something unknown" means "on".
  return { enabled: true, name: isGraphPresetName(value) ? value : 'default' };
}

/**
 * Pass-graph gate — **on by default**.
 *
 * Every session compiles the default graph and, on WebGPU, draws it with the
 * `GraphExecutor`. `?graph=blur` / `?graph=warp`, the starter graphs
 * `?graph=smear` / `?graph=feedback` and `?graph=trails3` select a different
 * *shape* — a graph the hand-written encoder cannot express. `?graph=0` (or a
 * stored `'0'`) is the escape hatch back to the hand encoder, for one release
 * while the hand encoder still exists. The WebGL diagnostic backend compiles
 * but does not execute, so it stays on its hand encoder either way.
 *
 * The URL wins over the stored preference, and storage a hardened browser
 * blocks reads as "no preference".
 */
export function passGraphSelection(search?: string): PassGraphSelection {
  let explicit: string | null = null;
  try {
    explicit = new URLSearchParams(search ?? window.location.search).get('graph');
  } catch {
    // No `window` (a worker, Node): no URL to read.
  }
  if (explicit !== null) return selectionFor(explicit);

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be disabled in hardened browsers.
  }
  return stored === null ? DEFAULT_SELECTION : selectionFor(stored);
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
    const message = passGraphRefusal(error);
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

/**
 * Record the variant a renderer compiled for this frame — the temporal term
 * switched on, say. `passGraphPasses` and friends describe the graph being
 * drawn, so they follow it; `passGraphExecuting` is left to the renderer, which
 * republishes it once the device has validated the variant's pipelines.
 */
export function publishGraphVariant(
  compiled: CompiledGraph | null,
  error: string | null,
  name: GraphPresetName,
  variant: string,
): void {
  if (typeof window === 'undefined') return;
  publishCompile(true, compiled, error, name);
  window.passGraphVariant = variant;
}

/** Record what one slot's executor is drawing; `undefined` drops the slot. */
export function publishSlotExecuting(slot: string, name: GraphPresetName | null | undefined): void {
  if (typeof window === 'undefined') return;
  const slots = { ...(window.passGraphSlotsExecuting ?? {}) };
  if (name === undefined) delete slots[slot];
  else slots[slot] = name;
  window.passGraphSlotsExecuting = slots;
}

function publish(
  active: boolean,
  compiled: CompiledGraph | null,
  error: string | null,
  name: GraphPresetName | null,
): void {
  if (typeof window === 'undefined') return;
  publishCompile(active, compiled, error, name);
  window.passGraphVariant = null;
  // Cleared for *every* result, not just a refusal: a successful WebGL compile
  // draws with the hand encoder, so leaving a previous WebGPU session's
  // `passGraphExecuting` in place would claim an executor that is not running.
  // `setPassGraph` republishes after a WebGPU renderer adopts the graph.
  publishGraphExecutorBreadcrumbs(null, []);
}

function publishCompile(
  active: boolean,
  compiled: CompiledGraph | null,
  error: string | null,
  name: GraphPresetName | null,
): void {
  window.passGraphActive = active;
  window.passGraphCompileCount = graphCompileCount();
  window.passGraphPasses = compiled ? compiled.passes.map((pass) => pass.nodeId) : [];
  window.passGraphSlots = compiled ? { ...compiled.allocation.slotsByResolution } : {};
  window.passGraphRingFrames = compiled ? ringTexturesByResolution(compiled.allocation) : {};
  window.passGraphError = error;
  window.passGraphName = name;
}

/** Message for a refusal, as the breadcrumbs carry it. */
export function passGraphRefusal(error: unknown): string {
  return error instanceof PassGraphError ? `${error.code}: ${error.message}` : String(error);
}
