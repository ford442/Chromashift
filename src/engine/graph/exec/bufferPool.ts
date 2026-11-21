import { bufferResourceBytes } from '../allocate';
import type { AllocationPlan, BufferResource } from '../types';
import type { PoolSizes } from './pool';

/** Minimal slice of `GPUDevice` the buffer pool needs — a recording stub drives it in tests. */
export interface BufferPoolDevice {
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
}

/** One buffer resource on the device: its element array and, for an `append` buffer, its control block. */
export interface PooledBuffer {
  readonly resource: BufferResource;
  readonly items: GPUBuffer;
  /** The head and the indirect arguments; `null` for a `plain` buffer. */
  readonly control: GPUBuffer | null;
  /** What `items` and `control` occupy together. */
  readonly bytes: number;
}

/**
 * The executor's buffers, backed by the compiler's `AllocationPlan.buffers` —
 * the buffer half of the pool, beside `TexturePool`'s textures.
 *
 * Lazy, as the textures are: a resource is created the first time a pass
 * binds it, so a plan with no buffers (the default graph) allocates nothing,
 * and {@link allocatedBytes} — the byte accounting a VRAM bound is asserted
 * on — reads 0 for it.
 *
 * A new plan keeps every buffer whose resource the new plan still has at the
 * same size, so a particle ring survives a variant switch (the temporal term
 * on, a layer count) that leaves its `emit` node in place, exactly as a tracer
 * does. New sizes drop only the buffers sized per pixel.
 */
export class GraphBufferPool {
  private readonly device: BufferPoolDevice;
  private plan: AllocationPlan | null = null;
  private sizes: PoolSizes | null = null;
  private readonly resources = new Map<string, BufferResource>();
  private readonly live = new Map<string, PooledBuffer>();

  /** Buffers created since construction — the churn probe tests read. */
  bufferCreateCount = 0;

  constructor(device: BufferPoolDevice) {
    this.device = device;
  }

  configure(plan: AllocationPlan, sizes: PoolSizes): void {
    if (this.plan === plan && this.sizes === sizes) return;
    this.plan = plan;
    this.sizes = sizes;
    this.resources.clear();
    for (const resource of plan.buffers) this.resources.set(resource.id, resource);
    for (const [id, pooled] of this.live) {
      const next = this.resources.get(id);
      const keep = next !== undefined
        && next.layout === pooled.resource.layout
        && next.stride === pooled.resource.stride
        && bufferResourceBytes(next, sizes) === pooled.bytes;
      if (keep) continue;
      destroyPooled(pooled);
      this.live.delete(id);
    }
  }

  /** The buffers `nodeId` writes (an owner or an in-place writer) or reads through its producer. */
  buffersFor(nodeId: string): PooledBuffer {
    const id = this.plan?.assignment[nodeId];
    const resource = id === undefined ? undefined : this.resources.get(id);
    if (!resource || !this.sizes) throw new Error(`Graph node '${nodeId}' has no buffer resource.`);
    const existing = this.live.get(resource.id);
    if (existing) return existing;

    const itemBytes = bufferResourceBytes({ ...resource, controlBytes: 0 }, this.sizes);
    const items = this.device.createBuffer({
      label: `${resource.id}:items`,
      size: itemBytes,
      // Storage for the compute stages, vertex for `splat`'s instance
      // attributes, copy for clearing and for tests' readback.
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const control = resource.controlBytes > 0
      ? this.device.createBuffer({
        label: `${resource.id}:control`,
        size: resource.controlBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      })
      : null;
    this.bufferCreateCount += control ? 2 : 1;
    const pooled: PooledBuffer = { resource, items, control, bytes: itemBytes + resource.controlBytes };
    this.live.set(resource.id, pooled);
    return pooled;
  }

  /** Bytes every live buffer occupies right now. */
  allocatedBytes(): number {
    let total = 0;
    for (const pooled of this.live.values()) total += pooled.bytes;
    return total;
  }

  /** Every live buffer — what `clearAccumulators()` zeroes, since the persistent ones are state. */
  liveBuffers(): PooledBuffer[] {
    return [...this.live.values()];
  }

  release(): void {
    for (const pooled of this.live.values()) destroyPooled(pooled);
    this.live.clear();
    this.resources.clear();
    this.plan = null;
    this.sizes = null;
  }
}

function destroyPooled(pooled: PooledBuffer): void {
  pooled.items.destroy();
  pooled.control?.destroy();
}
