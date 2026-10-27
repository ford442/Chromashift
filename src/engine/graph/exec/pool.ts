import { EXTERNAL_SLOT, SWAPCHAIN_SLOT } from '../allocate';
import type { AllocationPlan, HistoryRing, PoolSlot, ResolutionClass } from '../types';

/** Pixel size for one resolution class. */
export interface ClassSize {
  readonly width: number;
  readonly height: number;
}

export type PoolSizes = Readonly<Record<ResolutionClass, ClassSize>>;

/**
 * Minimal slice of `GPUDevice` the pool needs. Narrowing it here is what lets
 * `pool.test.ts` drive the allocator with a recording stub instead of a real
 * adapter — the pool's job is bookkeeping, and bookkeeping is testable.
 */
export interface PoolDevice {
  createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
}

/**
 * What a pooled texture is for. `color` is every node target, ring slot and
 * accumulator; `diagnostic` the fused pass's stamp side-channel; `msaa` the
 * band layers' shared multisample target.
 */
export type PoolTextureUse = 'color' | 'diagnostic' | 'msaa';

/**
 * How a backend makes and frees one pooled texture. The pool decides *which*
 * textures exist and when; this is the only part that differs between the
 * WebGPU executor (`GPUTexture`) and the WebGL one (an FBO-backed target).
 */
export interface PoolTextureFactory<T> {
  create(size: ClassSize, use: PoolTextureUse, sampleCount: number): T;
  destroy(texture: T): void;
}

/** rgba8unorm side-channel the fused coincidence/decay pass writes at @location(1). */
const DIAGNOSTIC_FORMAT: GPUTextureFormat = 'rgba8unorm';

/** The WebGPU executor's textures: render targets it can also sample and copy out of. */
function gpuTextureFactory(device: PoolDevice, internalFormat: GPUTextureFormat): PoolTextureFactory<GPUTexture> {
  return {
    create: (size, use, sampleCount) => device.createTexture({
      size: [Math.max(1, size.width), Math.max(1, size.height), 1],
      format: use === 'diagnostic' ? DIAGNOSTIC_FORMAT : internalFormat,
      sampleCount,
      usage: sampleCount > 1
        ? GPUTextureUsage.RENDER_ATTACHMENT
        : GPUTextureUsage.RENDER_ATTACHMENT
          | GPUTextureUsage.TEXTURE_BINDING
          | GPUTextureUsage.COPY_SRC,
    }),
    destroy: (texture) => texture.destroy(),
  };
}

/**
 * Render targets for one compiled graph, backed by the compiler's
 * `AllocationPlan`. Generic over the texture type, so the WebGPU and WebGL
 * executors share one set of lifetime rules rather than two copies of them.
 *
 * The plan already decided *which* nodes share a target; this turns that plan
 * into textures. Three rules carry over from the hand-written encoder:
 *
 * - `source` nodes bind an externally supplied texture and `output` nodes write
 *   the swapchain, so neither gets a texture here.
 * - A `persist:` slot is a ping-pong pair — one texture read, one written, both
 *   surviving to the next frame.
 * - Everything else is a pooled transient, created **lazily**. A slot the
 *   executor never writes (the fused `coincidence` node, whose pass its `decay`
 *   consumers absorb) therefore costs no VRAM, even though the plan sized it.
 *
 * A `history` node's ring is the fourth kind of storage: `frames` textures that
 * outlive the frame like a ping-pong pair, advanced by the same `flip()`.
 */
export class TexturePool<T> {
  private readonly factory: PoolTextureFactory<T>;

  private plan: AllocationPlan | null = null;
  private sizes: PoolSizes | null = null;
  private sampleCount = 1;

  private readonly slotById = new Map<string, PoolSlot>();
  private readonly ringByNode = new Map<string, HistoryRing>();
  private readonly rings = new Map<string, T[]>();
  /**
   * Ring write position and fill level, shared by every ring in the graph the
   * way `phase` is shared by every ping-pong pair. `head` is the slot written
   * *this* frame; `filled` counts slots holding a real frame (capped per ring).
   */
  private ringFrame = 0;
  private ringFilled = 0;
  private readonly transients = new Map<string, T>();
  private readonly pairs = new Map<string, [T, T]>();
  private readonly diagnostics = new Map<string, [T, T]>();
  private msaa: T | null = null;

  /** Ping-pong phase, flipped once per frame so every `decay` node stays in step. */
  private phase: 0 | 1 = 0;

  /** Textures created since construction — the leak/churn probe unit tests read. */
  textureCreateCount = 0;

  constructor(factory: PoolTextureFactory<T>) {
    this.factory = factory;
  }

  /**
   * Point the pool at a plan and a set of sizes. Re-configuring with the same
   * plan and sizes is a no-op, so a per-frame call costs nothing.
   *
   * New sizes drop every texture, because a pooled target's size *is* its
   * identity. A new plan at the same sizes — the graph changed shape, say the
   * temporal term was switched on — keeps every texture whose slot the new plan
   * still has, along with the ping-pong phase and the ring heads. Accumulator
   * and ring slots are named after their node (`persist:tracer-above`), so a
   * tracer survives a topology change that leaves its node in place, exactly
   * as the hand encoder's trails survive a motion-mode change.
   */
  configure(plan: AllocationPlan, sizes: PoolSizes, sampleCount: number): void {
    if (
      this.plan === plan
      && this.sizes !== null
      && this.sampleCount === sampleCount
      && sameSizes(this.sizes, sizes)
    ) {
      return;
    }

    const keep = this.plan !== null && this.sizes !== null && sameSizes(this.sizes, sizes);
    if (keep) {
      this.retainFor(plan, sampleCount);
    } else {
      this.release();
      this.phase = 0;
      this.ringFrame = 0;
      this.ringFilled = 0;
    }
    this.plan = plan;
    this.sizes = sizes;
    this.sampleCount = sampleCount;
    this.slotById.clear();
    for (const slot of plan.slots) this.slotById.set(slot.id, slot);
    this.ringByNode.clear();
    for (const ring of plan.rings) this.ringByNode.set(ring.nodeId, ring);
  }

  /** Drop the textures `plan` has no slot for (or a ring of another length). */
  private retainFor(plan: AllocationPlan, sampleCount: number): void {
    const slots = new Map(plan.slots.map((slot) => [slot.id, slot]));
    const rings = new Map(plan.rings.map((ring) => [ring.id, ring]));
    const prune = <T>(map: Map<string, T>, alive: (id: string) => boolean, destroy: (value: T) => void) => {
      for (const [id, value] of map) {
        if (alive(id)) continue;
        destroy(value);
        map.delete(id);
      }
    };
    const sameSlot = (id: string) => {
      const before = this.slotById.get(id);
      const after = slots.get(id);
      return before !== undefined && after !== undefined && before.resolution === after.resolution;
    };
    const free = (texture: T) => this.factory.destroy(texture);
    prune(this.transients, sameSlot, free);
    prune(this.pairs, sameSlot, ([a, b]) => { free(a); free(b); });
    prune(this.diagnostics, sameSlot, ([a, b]) => { free(a); free(b); });
    prune(
      this.rings,
      (id) => {
        const before = [...this.ringByNode.values()].find((ring) => ring.id === id);
        const after = rings.get(id);
        return before !== undefined && after !== undefined
          && before.frames === after.frames && before.resolution === after.resolution;
      },
      (textures) => { for (const texture of textures) free(texture); },
    );
    if (sampleCount !== this.sampleCount && this.msaa) {
      free(this.msaa);
      this.msaa = null;
    }
  }

  /**
   * Advance the ping-pong phase and every ring's head. Call once per encoded
   * frame, after encoding; a paused frame skips it, which freezes both.
   */
  flip(): void {
    this.phase = this.phase === 0 ? 1 : 0;
    this.ringFrame += 1;
    this.ringFilled += 1;
  }

  /**
   * One `history` node's ring: its textures, the slot this frame writes, and how
   * many slots hold a real frame once that write lands.
   */
  ring(nodeId: string): { textures: T[]; head: number; filled: number } {
    const ring = this.ringByNode.get(nodeId);
    if (!ring) throw new Error(`Graph node '${nodeId}' has no history ring.`);
    let textures = this.rings.get(ring.id);
    if (!textures) {
      textures = Array.from(
        { length: ring.frames },
        () => this.create(ring.resolution, 'color'),
      );
      this.rings.set(ring.id, textures);
    }
    return {
      textures,
      head: this.ringFrame % ring.frames,
      filled: Math.min(this.ringFilled + 1, ring.frames),
    };
  }

  /**
   * Forget every frame the rings hold. Paired with clearing their textures, so
   * the trail restarts from this frame rather than weighting zeroed slots.
   */
  resetRings(): void {
    this.ringFilled = 0;
  }

  /** Index of the texture a `decay` node *reads* this frame. */
  get readPhase(): 0 | 1 {
    return this.phase;
  }

  /** Index of the texture a `decay` node *writes* this frame. */
  get writePhase(): 0 | 1 {
    return this.phase === 0 ? 1 : 0;
  }

  /** The slot a node writes, or `null` for external / swapchain targets. */
  slotFor(nodeId: string): PoolSlot | null {
    const slotId = this.plan?.assignment[nodeId];
    if (slotId === undefined || slotId === EXTERNAL_SLOT || slotId === SWAPCHAIN_SLOT) return null;
    return this.slotById.get(slotId) ?? null;
  }

  /** True when this node's result lands on the swapchain rather than in the pool. */
  writesSwapchain(nodeId: string): boolean {
    return this.plan?.assignment[nodeId] === SWAPCHAIN_SLOT;
  }

  /** The pooled transient a non-ping-pong node writes (and its readers sample). */
  transient(nodeId: string): T {
    const slot = this.requireSlot(nodeId);
    const existing = this.transients.get(slot.id);
    if (existing) return existing;
    const texture = this.create(slot.resolution, 'color');
    this.transients.set(slot.id, texture);
    return texture;
  }

  /** The read/write pair a `decay` node accumulates into. */
  pingPong(nodeId: string): { read: T; write: T } {
    const slot = this.requireSlot(nodeId);
    let pair = this.pairs.get(slot.id);
    if (!pair) {
      pair = [this.create(slot.resolution, 'color'), this.create(slot.resolution, 'color')];
      this.pairs.set(slot.id, pair);
    }
    return { read: pair[this.readPhase], write: pair[this.writePhase] };
  }

  /**
   * The stamp-diagnostic attachment for a fused coincidence/decay pass. The
   * emitted shader always writes `@location(1)`, so the attachment is not
   * optional — but it ping-pongs with the tracer so a readback can name the
   * frame it came from, exactly as the shipped persistence pass did.
   */
  diagnostic(nodeId: string): { read: T; write: T } {
    const slot = this.requireSlot(nodeId);
    let pair = this.diagnostics.get(slot.id);
    if (!pair) {
      pair = [this.create(slot.resolution, 'diagnostic'), this.create(slot.resolution, 'diagnostic')];
      this.diagnostics.set(slot.id, pair);
    }
    return { read: pair[this.readPhase], write: pair[this.writePhase] };
  }

  /**
   * Every accumulator texture the pool owns — both sides of each ping-pong
   * pair and their diagnostic attachments.
   *
   * `clearPersistence()` clears these: they are the tracer state. The
   * `history` rings are trails too, so they are cleared with them.
   */
  accumulatorTextures(): T[] {
    return [
      ...[...this.pairs.values()].flat(),
      ...[...this.diagnostics.values()].flat(),
      ...[...this.rings.values()].flat(),
    ];
  }

  /** Ring textures created so far — what `history` costs in VRAM right now. */
  ringTextureCount(): number {
    return [...this.rings.values()].reduce((total, ring) => total + ring.length, 0);
  }

  /**
   * Shared multisample target for `band-layer` passes, matching the hand
   * encoder: one MSAA texture, resolved into the pooled layer target at the end
   * of each pass.
   */
  msaaTarget(): T | null {
    if (this.sampleCount <= 1) return null;
    this.msaa ??= this.create('layer', 'msaa', this.sampleCount);
    return this.msaa;
  }

  release(): void {
    const free = (texture: T) => this.factory.destroy(texture);
    for (const texture of this.transients.values()) free(texture);
    for (const [a, b] of this.pairs.values()) { free(a); free(b); }
    for (const [a, b] of this.diagnostics.values()) { free(a); free(b); }
    for (const ring of this.rings.values()) for (const texture of ring) free(texture);
    if (this.msaa) free(this.msaa);
    this.transients.clear();
    this.pairs.clear();
    this.diagnostics.clear();
    this.rings.clear();
    this.msaa = null;
    this.plan = null;
    this.sizes = null;
  }

  private requireSlot(nodeId: string): PoolSlot {
    const slot = this.slotFor(nodeId);
    if (!slot) {
      throw new Error(`Graph node '${nodeId}' has no pooled render target.`);
    }
    return slot;
  }

  private create(resolution: ResolutionClass, use: PoolTextureUse, sampleCount = 1): T {
    const size = this.sizes?.[resolution];
    if (!size) throw new Error(`No size configured for the '${resolution}' resolution class.`);
    this.textureCreateCount += 1;
    return this.factory.create(size, use, sampleCount);
  }
}

/** The WebGPU executor's pool, in the device's internal colour format. */
export class GraphTexturePool extends TexturePool<GPUTexture> {
  constructor(device: PoolDevice, internalFormat: GPUTextureFormat) {
    super(gpuTextureFactory(device, internalFormat));
  }
}

function sameSizes(a: PoolSizes, b: PoolSizes): boolean {
  return (Object.keys(a) as ResolutionClass[]).every(
    (key) => a[key].width === b[key].width && a[key].height === b[key].height,
  );
}
