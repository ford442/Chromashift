import { nodeKindSpec } from './nodeKinds';
import type { Schedule } from './schedule';
import type {
  AllocationPlan,
  HistoryRing,
  PoolSlot,
  ResolutionClass,
  TextureLifetime,
} from './types';

/** Slot ids for targets the pool does not own. */
export const EXTERNAL_SLOT = 'external';
export const SWAPCHAIN_SLOT = 'swapchain';

const RESOLUTION_CLASSES: ResolutionClass[] = ['source', 'layer', 'tracer', 'output'];

/**
 * Transient texture pool.
 *
 * Today every intermediate is a permanently allocated texture. A 12-node graph
 * is only affordable if non-overlapping lifetimes share one render target, so
 * this is load-bearing, not an optimisation: a linear scan over the schedule
 * hands each node a free slot of its resolution class and returns the slot once
 * the last reader has run.
 *
 * `source` nodes bind externally supplied textures and `output` nodes write the
 * swapchain, so neither consumes a pool slot. Ping-pong nodes hold two textures
 * across frames and are likewise excluded.
 *
 * A `history` node is both: its tap-mix *output* is an ordinary transient that
 * goes through the pool, while its ring of `frames` textures outlives the frame
 * and is listed separately in `rings`, never pooled.
 */
export function allocateTextures(schedule: Schedule): AllocationPlan {
  const lifetimeOf = new Map<string, TextureLifetime>();
  for (const lifetime of schedule.lifetimes) lifetimeOf.set(lifetime.nodeId, lifetime);

  // A pass read only by `output` nodes renders straight to the swapchain, the
  // way the hand-written compositor already does — no pool slot for it.
  const consumers = new Map<string, string[]>();
  for (const pass of schedule.passes) {
    for (const inputId of pass.inputs) {
      consumers.set(inputId, [...(consumers.get(inputId) ?? []), pass.kind]);
    }
  }
  const writesSwapchain = (nodeId: string): boolean => {
    const kinds = consumers.get(nodeId);
    return kinds !== undefined && kinds.length > 0 && kinds.every((kind) => kind === 'output');
  };

  const slots: PoolSlot[] = [];
  const rings: HistoryRing[] = [];
  const assignment: Record<string, string> = {};
  const free = new Map<ResolutionClass, PoolSlot[]>(
    RESOLUTION_CLASSES.map((resolution) => [resolution, []]),
  );
  // Slots handed out at pass i, keyed by the pass index that frees them.
  const expiry = new Map<string, number>();

  for (const pass of schedule.passes) {
    // Reclaim every slot whose last reader has already run.
    for (const slot of slots) {
      const releaseAt = expiry.get(slot.id);
      if (releaseAt !== undefined && releaseAt < pass.order) {
        expiry.delete(slot.id);
        free.get(slot.resolution)!.push(slot);
      }
    }

    const spec = nodeKindSpec(pass.kind);
    if (pass.kind === 'source') {
      assignment[pass.nodeId] = EXTERNAL_SLOT;
      continue;
    }
    if (spec.outputType === null) {
      assignment[pass.nodeId] = SWAPCHAIN_SLOT;
      continue;
    }

    // Ping-pong first: a `decay` whose only consumer is the output node still
    // needs its own history pair, or next frame's `prevTex` read has no
    // backing target. `consumers` is built from non-feedback inputs, so the
    // swapchain shortcut below cannot see that the node reads itself.
    const lifetime = lifetimeOf.get(pass.nodeId)!;
    if (lifetime.persistent) {
      const slot: PoolSlot = {
        id: `persist:${pass.nodeId}`,
        resolution: lifetime.resolution,
        nodes: [pass.nodeId],
      };
      slots.push(slot);
      assignment[pass.nodeId] = slot.id;
      continue;
    }

    if (pass.kind === 'history') {
      rings.push({
        id: `ring:${pass.nodeId}`,
        nodeId: pass.nodeId,
        resolution: lifetime.resolution,
        frames: schedule.historyFrames[pass.nodeId],
      });
    }

    if (writesSwapchain(pass.nodeId)) {
      assignment[pass.nodeId] = SWAPCHAIN_SLOT;
      continue;
    }

    const pool = free.get(lifetime.resolution)!;
    let slot = pool.pop();
    if (!slot) {
      slot = {
        id: `${lifetime.resolution}:${slots.filter((s) => s.resolution === lifetime.resolution).length}`,
        resolution: lifetime.resolution,
        nodes: [],
      };
      slots.push(slot);
    }
    slot.nodes.push(pass.nodeId);
    assignment[pass.nodeId] = slot.id;
    expiry.set(slot.id, lifetime.lastUse);
  }

  const slotsByResolution = Object.fromEntries(
    RESOLUTION_CLASSES.map((resolution) => [
      resolution,
      slots.filter((slot) => slot.resolution === resolution).length,
    ]),
  ) as Record<ResolutionClass, number>;

  return { slots, rings, assignment, lifetimes: schedule.lifetimes, slotsByResolution };
}

/** Ring textures per resolution class — `history`'s VRAM, beside `slotsByResolution`. */
export function ringTexturesByResolution(plan: AllocationPlan): Record<ResolutionClass, number> {
  return Object.fromEntries(
    RESOLUTION_CLASSES.map((resolution) => [
      resolution,
      plan.rings
        .filter((ring) => ring.resolution === resolution)
        .reduce((total, ring) => total + ring.frames, 0),
    ]),
  ) as Record<ResolutionClass, number>;
}

/**
 * VRAM proxy for a plan: bytes for every pool slot at the given resolutions.
 * Ping-pong slots count twice — they own a read and a write texture — and each
 * `history` ring counts `frames` times.
 */
export function estimateVram(
  plan: AllocationPlan,
  sizes: Record<ResolutionClass, { width: number; height: number; bytesPerPixel: number }>,
): number {
  const bytes = (resolution: ResolutionClass, copies: number): number => {
    const size = sizes[resolution];
    return size.width * size.height * size.bytesPerPixel * copies;
  };
  const pooled = plan.slots.reduce(
    (total, slot) => total + bytes(slot.resolution, slot.id.startsWith('persist:') ? 2 : 1),
    0,
  );
  return plan.rings.reduce((total, ring) => total + bytes(ring.resolution, ring.frames), pooled);
}

/** Nodes that share a pool slot — the reuse the budget test asserts on. */
export function sharedSlots(plan: AllocationPlan): PoolSlot[] {
  return plan.slots.filter((slot) => slot.nodes.length > 1);
}
