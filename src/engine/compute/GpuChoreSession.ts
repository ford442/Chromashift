/**
 * One `WebGpuChoreBackend` per `GPUDevice`, borrowed by every compute lane.
 *
 * Before this existed, three independent backends were constructed on the one
 * renderer device — `GpuImageAnalysis` (histogram + mask), `PersistencePass`
 * (op `coincidence`), and `MotionFieldPass` (op `motion-field`) — which meant
 * three copies of the compute pipelines, staging buffers, and bind-group
 * caches. Tolerable at 3-layer 1080p, wasteful once coincidence goes N-layer
 * and motion grows a second pass.
 *
 * Ownership is a **ref-counted lease** rather than a single owner, so lifecycle
 * stays decoupled: `PersistencePass.destroy()` releases its lease and the
 * backend survives for analysis, and the backend is destroyed only when the
 * last holder — normally `RendererOrchestrator`, which takes a lease for the
 * whole session — lets go.
 *
 * This module is deliberately on the Chromashift side of the `gpu-chores`
 * boundary (`chores/index.ts`): the kit stays a lane that adopts a device, and
 * who shares that lane is the host's policy.
 *
 * Breadcrumbs are unaffected — they are published per op (`gpuChoreBackend` vs
 * `motionFieldBackend`), not per backend instance.
 */

import { WebGpuChoreBackend } from './chores';

interface GpuChoreSessionEntry {
  backend: WebGpuChoreBackend;
  refs: number;
}

/**
 * A borrowed reference to the device's shared backend. Release exactly once,
 * from the holder's `destroy()`; a second release is a no-op rather than an
 * error so double-teardown cannot under-count the session into an early
 * destroy.
 */
export interface GpuChoreLease {
  readonly backend: WebGpuChoreBackend;
  release(): void;
}

const sessions = new WeakMap<GPUDevice, GpuChoreSessionEntry>();

/** Number of `WebGpuChoreBackend`s this module has constructed. Test signal. */
let backendsConstructed = 0;

/**
 * Borrow the device's chore backend, constructing it on first use.
 *
 * Every caller on the same `GPUDevice` gets the same instance. The op-level
 * caches inside the backend are keyed per op (mask texture, motion history,
 * coincidence bind groups), so analysis at source resolution and coincidence at
 * tracer resolution do not contend for the same cached resource.
 */
export function acquireGpuChoreSession(device: GPUDevice): GpuChoreLease {
  let entry = sessions.get(device);
  if (!entry) {
    backendsConstructed += 1;
    entry = { backend: new WebGpuChoreBackend(device), refs: 0 };
    sessions.set(device, entry);
  }
  entry.refs += 1;

  const held = entry;
  let released = false;
  return {
    backend: held.backend,
    release(): void {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      sessions.delete(device);
      held.backend.destroy();
    },
  };
}

/** Live lease count for `device`, or 0 when no backend is open on it. */
export function gpuChoreSessionRefCount(device: GPUDevice): number {
  return sessions.get(device)?.refs ?? 0;
}

/** How many backends have been constructed since the last reset. Test signal. */
export function gpuChoreBackendsConstructed(): number {
  return backendsConstructed;
}

/** Test-only: forget the construct tally. Does not touch live leases. */
export function resetGpuChoreSessionStatsForTests(): void {
  backendsConstructed = 0;
}
