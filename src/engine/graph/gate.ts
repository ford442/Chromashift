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
    /**
     * Name of the graph shape the primary canvas's executor drew last frame —
     * the selected one, or `default` standing in for a variant it refused —
     * or `null` for a frame nothing validated could draw.
     */
    passGraphExecuting?: GraphPresetName | null;
    /**
     * The variant (`graphVariantKey`) that frame drew. It trails
     * `passGraphVariant` while the device validates a new variant, since the
     * last one keeps drawing until then.
     */
    passGraphDrawnVariant?: string | null;
    /**
     * Node ids the executor actually encodes, in order. Shorter than
     * `passGraphPasses`: `source` and `output` own no pass, and a `coincidence`
     * fused into its `decay` consumers is absorbed by them.
     */
    passGraphExecutedPasses?: string[];
    /**
     * Per orchestrator slot (`main`, `compare-b`, the quad cells): the graph
     * shape that slot's executor drew last frame, or `null` while nothing
     * validated could draw it. Absent for a slot that has no renderer.
     */
    passGraphSlotsExecuting?: Record<string, GraphPresetName | null>;
  }
}

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
  if (typeof window === 'undefined') return;
  window.passGraphExecuting = name;
  window.passGraphExecutedPasses = encodedPasses;
  window.passGraphDrawnVariant = variant;
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
