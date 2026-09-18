import { EXTERNAL_SLOT, SWAPCHAIN_SLOT } from '../allocate';
import type { AllocationPlan, PoolSlot, ResolutionClass } from '../types';

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

/** rgba8unorm side-channel the fused coincidence/decay pass writes at @location(1). */
const DIAGNOSTIC_FORMAT: GPUTextureFormat = 'rgba8unorm';

/**
 * Render targets for one compiled graph, backed by the compiler's
 * `AllocationPlan`.
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
 */
export class GraphTexturePool {
  private readonly device: PoolDevice;
  private readonly internalFormat: GPUTextureFormat;

  private plan: AllocationPlan | null = null;
  private sizes: PoolSizes | null = null;
  private sampleCount = 1;

  private readonly slotById = new Map<string, PoolSlot>();
  private readonly transients = new Map<string, GPUTexture>();
  private readonly pairs = new Map<string, [GPUTexture, GPUTexture]>();
  private readonly diagnostics = new Map<string, [GPUTexture, GPUTexture]>();
  private msaa: GPUTexture | null = null;

  /** Ping-pong phase, flipped once per frame so every `decay` node stays in step. */
  private phase: 0 | 1 = 0;

  /** Textures created since construction — the leak/churn probe unit tests read. */
  textureCreateCount = 0;

  constructor(device: PoolDevice, internalFormat: GPUTextureFormat) {
    this.device = device;
    this.internalFormat = internalFormat;
  }

  /**
   * Point the pool at a plan and a set of sizes. Re-configuring with the same
   * plan and sizes is a no-op, so a per-frame call costs nothing; anything else
   * drops every texture, because a pooled target's size *is* its identity.
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

    this.release();
    this.plan = plan;
    this.sizes = sizes;
    this.sampleCount = sampleCount;
    this.slotById.clear();
    for (const slot of plan.slots) this.slotById.set(slot.id, slot);
    this.phase = 0;
  }

  /** Advance the ping-pong phase. Call once per encoded frame, after encoding. */
  flip(): void {
    this.phase = this.phase === 0 ? 1 : 0;
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
  transient(nodeId: string): GPUTexture {
    const slot = this.requireSlot(nodeId);
    const existing = this.transients.get(slot.id);
    if (existing) return existing;
    const texture = this.create(slot.resolution, this.internalFormat);
    this.transients.set(slot.id, texture);
    return texture;
  }

  /** The read/write pair a `decay` node accumulates into. */
  pingPong(nodeId: string): { read: GPUTexture; write: GPUTexture } {
    const slot = this.requireSlot(nodeId);
    let pair = this.pairs.get(slot.id);
    if (!pair) {
      pair = [
        this.create(slot.resolution, this.internalFormat),
        this.create(slot.resolution, this.internalFormat),
      ];
      this.pairs.set(slot.id, pair);
    }
    return { read: pair[this.readPhase], write: pair[this.writePhase] };
  }

  /**
   * The stamp-diagnostic attachment for a fused coincidence/decay pass. The
   * emitted shader always writes `@location(1)`, so the attachment is not
   * optional — but it ping-pongs with the tracer so a readback can name the
   * frame it came from, exactly as `PersistencePass` does.
   */
  diagnostic(nodeId: string): { read: GPUTexture; write: GPUTexture } {
    const slot = this.requireSlot(nodeId);
    let pair = this.diagnostics.get(slot.id);
    if (!pair) {
      pair = [
        this.create(slot.resolution, DIAGNOSTIC_FORMAT),
        this.create(slot.resolution, DIAGNOSTIC_FORMAT),
      ];
      this.diagnostics.set(slot.id, pair);
    }
    return { read: pair[this.readPhase], write: pair[this.writePhase] };
  }

  /**
   * Shared multisample target for `band-layer` passes, matching the hand
   * encoder: one MSAA texture, resolved into the pooled layer target at the end
   * of each pass.
   */
  msaaTarget(): GPUTexture | null {
    if (this.sampleCount <= 1) return null;
    this.msaa ??= this.create('layer', this.internalFormat, this.sampleCount);
    return this.msaa;
  }

  release(): void {
    for (const texture of this.transients.values()) texture.destroy();
    for (const [a, b] of this.pairs.values()) { a.destroy(); b.destroy(); }
    for (const [a, b] of this.diagnostics.values()) { a.destroy(); b.destroy(); }
    this.msaa?.destroy();
    this.transients.clear();
    this.pairs.clear();
    this.diagnostics.clear();
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

  private create(
    resolution: ResolutionClass,
    format: GPUTextureFormat,
    sampleCount = 1,
  ): GPUTexture {
    const size = this.sizes?.[resolution];
    if (!size) throw new Error(`No size configured for the '${resolution}' resolution class.`);
    this.textureCreateCount += 1;
    return this.device.createTexture({
      size: [Math.max(1, size.width), Math.max(1, size.height), 1],
      format,
      sampleCount,
      usage: sampleCount > 1
        ? GPUTextureUsage.RENDER_ATTACHMENT
        : GPUTextureUsage.RENDER_ATTACHMENT
          | GPUTextureUsage.TEXTURE_BINDING
          | GPUTextureUsage.COPY_SRC,
    });
  }
}

function sameSizes(a: PoolSizes, b: PoolSizes): boolean {
  return (Object.keys(a) as ResolutionClass[]).every(
    (key) => a[key].width === b[key].width && a[key].height === b[key].height,
  );
}
