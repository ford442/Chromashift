import { ringTexturesByResolution } from './allocate';
import { buildGraphPreset, isGraphPresetName, type GraphPresetName } from './altGraphs';
import { compileGraph, graphCompileCount } from './compile';
import { PassGraphError } from './errors';
import type { CompiledGraph, GraphBackend } from './types';
import { publishDiagnostic, publishDiagnostics, readDiagnostic } from '../diagnostics';

const STORAGE_KEY = 'chromashift.passGraph';

/** The shape the gate resolved from the URL or the stored preference. */
export interface PassGraphSelection {
  name: GraphPresetName;
}

/** What a session with no `?graph` and no stored preference gets. */
const DEFAULT_SELECTION: PassGraphSelection = { name: 'default' };

let warnedRetiredOptOut = false;

/** A `?graph=` value (or the stored preference) as a selection. */
function selectionFor(value: string): PassGraphSelection {
  if (value === '0' || value === 'false') {
    // The opt-out to the hand encoder, for the release it outlived the flip.
    if (!warnedRetiredOptOut) {
      warnedRetiredOptOut = true;
      console.warn('[Chromashift:PassGraph] ?graph=0 selected the hand encoder, which has been removed; drawing the default graph.');
    }
    return DEFAULT_SELECTION;
  }
  // An unrecognised value is the default graph, not a refusal: the gate's job
  // is to pick a shape.
  return { name: isGraphPresetName(value) ? value : 'default' };
}

/**
 * Pass-graph gate: which shape the session draws.
 *
 * Every session compiles a graph and, on WebGPU, draws it with the
 * `GraphExecutor` — the default graph unless `?graph=blur` / `?graph=warp`,
 * the starter graphs `?graph=smear` / `?graph=feedback` or `?graph=trails3`
 * (or a stored `chromashift.passGraph` preference) select another. The WebGL
 * diagnostic backend compiles but does not execute, so it stays on its
 * hand-written passes either way.
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

/** Store the shape a session without `?graph` draws; `null` forgets it. */
export function setStoredPassGraphPreference(name: GraphPresetName | null): void {
  try {
    if (name === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Storage can be disabled in hardened test browsers.
  }
}

/**
 * Compile the selected graph for `backend` and publish the breadcrumbs.
 *
 * Returns the compiled graph, or `null` when compilation refused it — the
 * refusal is published rather than swallowed. On WebGPU a refused shape still
 * draws: the renderer stands the default graph in for it.
 */
export function activatePassGraph(
  backend: GraphBackend,
  layerCount?: number,
): CompiledGraph | null {
  const selection = passGraphSelection();
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
  variant: string | null = null,
): void {
  publishDiagnostics({
    passGraphExecuting: name,
    passGraphExecutedPasses: encodedPasses,
    passGraphDrawnVariant: variant,
  });
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
  publishCompile(true, compiled, error, name);
  publishDiagnostic('passGraphVariant', variant);
}

/** Record what one slot's executor is drawing; `undefined` drops the slot. */
export function publishSlotExecuting(slot: string, name: GraphPresetName | null | undefined): void {
  const slots = { ...(readDiagnostic('passGraphSlotsExecuting') ?? {}) };
  if (name === undefined) delete slots[slot];
  else slots[slot] = name;
  publishDiagnostic('passGraphSlotsExecuting', slots);
}

function publish(
  active: boolean,
  compiled: CompiledGraph | null,
  error: string | null,
  name: GraphPresetName | null,
): void {
  publishCompile(active, compiled, error, name);
  publishDiagnostic('passGraphVariant', null);
  // Cleared for *every* result, not just a refusal: a WebGL compile draws
  // nothing with it, so leaving a previous WebGPU session's
  // `passGraphExecuting` in place would claim an executor that is not running.
  // A WebGPU renderer republishes it from the first frame it draws.
  publishGraphExecutorBreadcrumbs(null, []);
}

function publishCompile(
  active: boolean,
  compiled: CompiledGraph | null,
  error: string | null,
  name: GraphPresetName | null,
): void {
  publishDiagnostics({
    passGraphActive: active,
    passGraphCompileCount: graphCompileCount(),
    passGraphPasses: compiled ? compiled.passes.map((pass) => pass.nodeId) : [],
    passGraphSlots: compiled ? { ...compiled.allocation.slotsByResolution } : {},
    passGraphRingFrames: compiled ? ringTexturesByResolution(compiled.allocation) : {},
    passGraphError: error,
    passGraphName: name,
  });
}

/** Message for a refusal, as the breadcrumbs carry it. */
export function passGraphRefusal(error: unknown): string {
  return error instanceof PassGraphError ? `${error.code}: ${error.message}` : String(error);
}
