import { APPEND_CONTROL_BYTES, nodeKindSpec } from './nodeKinds';
import type { Schedule } from './schedule';
import type {
  AllocationPlan,
  BufferResource,
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
 * and is listed separately in `rings`, never pooled. A `loop` history has only
 * the ring: its readers bind the previous slot and its write fills the head.
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
    // A buffer producer's output is a buffer resource, not a texture slot.
    if (spec.outputType === 'buffer') continue;
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
        // Every scheduled history node has one: validation refuses it without `frames`.
        frames: schedule.historyFrames[pass.nodeId]!,
      });
      // A loop's reads all bind a ring slot, and its write lands in one: no
      // taps pass, so no pooled output. The ring is its whole VRAM.
      if (schedule.loopHistories.includes(pass.nodeId)) {
        assignment[pass.nodeId] = `ring:${pass.nodeId}`;
        continue;
      }
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

  const buffers = allocateBuffers(schedule, assignment);

  return { slots, rings, buffers, assignment, lifetimes: schedule.lifetimes, slotsByResolution };
}

/**
 * The buffer half of the transient pool: one resource per owning node, and the
 * same linear scan as the textures for the ones that do not outlive the frame.
 *
 * - A **persistent** buffer (the particle ring) holds state some later frame
 *   reads, exactly as a ping-pong pair does, so it is never pooled.
 * - A **transient** one is handed a free resource of the same shape (layout,
 *   stride, element count) once every reader of the previous holder has run.
 * - An **in-place** writer (`advect`) is assigned its input's resource and
 *   keeps it live until its own last reader.
 *
 * Writes each node's resource id into `assignment`.
 */
export function allocateBuffers(schedule: Schedule, assignment: Record<string, string>): BufferResource[] {
  const lifetimeOf = new Map(schedule.bufferLifetimes.map((lifetime) => [lifetime.nodeId, lifetime]));
  const resources: BufferResource[] = [];
  const byId = new Map<string, BufferResource>();
  const free = new Map<string, BufferResource[]>();
  const expiry = new Map<string, number>();
  const shapeKey = (resource: Pick<BufferResource, 'layout' | 'stride' | 'elements'>): string =>
    `${resource.layout}:${resource.stride}:${JSON.stringify(resource.elements)}`;

  for (const pass of schedule.passes) {
    for (const resource of resources) {
      const releaseAt = expiry.get(resource.id);
      if (releaseAt !== undefined && releaseAt < pass.order) {
        expiry.delete(resource.id);
        const key = shapeKey(resource);
        free.set(key, [...(free.get(key) ?? []), resource]);
      }
    }

    const scheduled = schedule.buffers[pass.nodeId];
    const lifetime = lifetimeOf.get(pass.nodeId);
    if (!scheduled || !lifetime) continue;

    if (!scheduled.owns) {
      const resource = byId.get(assignment[scheduled.input] ?? '');
      if (!resource) {
        throw new Error(`Node '${pass.nodeId}' writes its input's buffer in place, but '${scheduled.input}' has none.`);
      }
      resource.nodes.push(pass.nodeId);
      assignment[pass.nodeId] = resource.id;
      if (!resource.persistent) {
        expiry.set(resource.id, Math.max(expiry.get(resource.id) ?? -1, lifetime.lastUse));
      }
      continue;
    }

    const shape = {
      layout: scheduled.layout,
      stride: scheduled.stride,
      elements: scheduled.elements,
    };
    if (scheduled.persistent) {
      const resource: BufferResource = {
        id: `persist-buffer:${pass.nodeId}`,
        owner: pass.nodeId,
        nodes: [pass.nodeId],
        ...shape,
        persistent: true,
        controlBytes: scheduled.layout === 'append' ? APPEND_CONTROL_BYTES : 0,
      };
      resources.push(resource);
      byId.set(resource.id, resource);
      assignment[pass.nodeId] = resource.id;
      continue;
    }

    let resource = free.get(shapeKey(shape))?.pop();
    if (!resource) {
      resource = {
        id: `buffer:${resources.filter((r) => !r.persistent).length}`,
        owner: pass.nodeId,
        nodes: [],
        ...shape,
        persistent: false,
        controlBytes: scheduled.layout === 'append' ? APPEND_CONTROL_BYTES : 0,
      };
      resources.push(resource);
      byId.set(resource.id, resource);
    }
    resource.nodes.push(pass.nodeId);
    assignment[pass.nodeId] = resource.id;
    expiry.set(resource.id, lifetime.lastUse);
  }
  return resources;
}

/** Element count of a buffer at the frame's sizes (a per-pixel count needs them). */
export function bufferElementCount(
  resource: Pick<BufferResource, 'elements'>,
  sizes?: Partial<Record<ResolutionClass, { width: number; height: number }>>,
): number {
  if (typeof resource.elements === 'number') return resource.elements;
  const size = sizes?.[resource.elements.perPixel];
  if (!size) throw new Error(`No size for the '${resource.elements.perPixel}' resolution class.`);
  return Math.max(1, size.width) * Math.max(1, size.height);
}

/** Bytes one buffer resource occupies on the device: its elements and its control block. */
export function bufferResourceBytes(
  resource: Pick<BufferResource, 'elements' | 'stride' | 'controlBytes'>,
  sizes?: Partial<Record<ResolutionClass, { width: number; height: number }>>,
): number {
  return bufferElementCount(resource, sizes) * resource.stride + resource.controlBytes;
}

/** Bytes every buffer resource in `plan` occupies — the buffer half of the VRAM bound. */
export function planBufferBytes(
  plan: Pick<AllocationPlan, 'buffers'>,
  sizes?: Partial<Record<ResolutionClass, { width: number; height: number }>>,
): number {
  return plan.buffers.reduce((total, resource) => total + bufferResourceBytes(resource, sizes), 0);
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
 * Ping-pong slots count twice — they own a read and a write texture — each
 * `history` ring counts `frames` times, and every buffer resource adds its
 * bytes ({@link planBufferBytes}).
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
  const ringed = plan.rings.reduce((total, ring) => total + bytes(ring.resolution, ring.frames), pooled);
  return ringed + planBufferBytes(plan, sizes);
}

/** Nodes that share a pool slot — the reuse the budget test asserts on. */
export function sharedSlots(plan: AllocationPlan): PoolSlot[] {
  return plan.slots.filter((slot) => slot.nodes.length > 1);
}
