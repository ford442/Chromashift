/**
 * `gpu-chores` — the facade.
 *
 * `runJob({ op, prefer: 'auto' })` walks the fixed backend order and returns
 * the first lane that accepts the job. Every decline and every throw is
 * recorded in `attempts`, so a Chrome-vs-Edge divergence shows up as a
 * reason string rather than a blank analysis.
 *
 * WebGL2 is intentionally not a lane. Histogram atomics have no workable GL2
 * story, and standing up a compute device *and* a GL context for the same
 * analysis is the failure mode this kit exists to prevent — a WebGL renderer
 * simply registers no `webgpu` lane and falls through to WASM/TS.
 */

import { publishChoreBreadcrumbs } from './support';
import {
  CHORE_BACKEND_ORDER,
  type ChoreAttempt,
  type ChoreBackend,
  type ChoreBackendImpl,
  type ChoreJob,
  type ChoreOutput,
  type ChoreResult,
  type ChoresRuntime,
  type CoincidenceJob,
  type GpuCoincidenceOutput,
  type ImageAnalysisJob,
  type ImageAnalysisOutput,
} from './types';

export class ChoreRuntimeImpl implements ChoresRuntime {
  private readonly backends = new Map<ChoreBackend, ChoreBackendImpl>();

  constructor(backends: readonly ChoreBackendImpl[]) {
    for (const backend of backends) {
      this.backends.set(backend.backend, backend);
    }
  }

  availableBackends(): readonly ChoreBackend[] {
    return CHORE_BACKEND_ORDER.filter((name) => this.backends.has(name));
  }

  /** Lanes to try, in order, for a given preference. */
  private candidates(prefer: ChoreJob['prefer']): readonly ChoreBackend[] {
    if (!prefer || prefer === 'auto') return CHORE_BACKEND_ORDER;
    // A pinned lane never slides to another one: parity tests depend on
    // `prefer: 'ts'` actually meaning TS.
    return [prefer];
  }

  runJob(job: ImageAnalysisJob): Promise<ChoreResult<ImageAnalysisOutput>>;
  runJob(job: CoincidenceJob): Promise<ChoreResult<GpuCoincidenceOutput>>;
  async runJob(job: ChoreJob): Promise<ChoreResult<ChoreOutput>> {
    const attempts: ChoreAttempt[] = [];

    for (const name of this.candidates(job.prefer)) {
      const backend = this.backends.get(name);
      if (!backend) {
        attempts.push({ backend: name, outcome: 'declined', reason: 'Lane not registered' });
        continue;
      }

      if (!backend.canRun(job)) {
        attempts.push({ backend: name, outcome: 'declined', reason: backend.declineReason(job) });
        continue;
      }

      try {
        const value = await backend.run(job);
        if (value) {
          publishChoreBreadcrumbs(backend.breadcrumbLabel?.() ?? name, null);
          return { ok: true, backend: name, value };
        }
        attempts.push({ backend: name, outcome: 'failed', reason: 'Lane returned no result' });
      } catch (error) {
        attempts.push({
          backend: name,
          outcome: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const reason = attempts.length === 0
      ? 'No backends registered'
      : attempts.map((a) => `${a.backend}: ${a.reason}`).join('; ');
    publishChoreBreadcrumbs(null, reason);
    return { ok: false, backend: null, reason, attempts };
  }

  destroy(): void {
    for (const backend of this.backends.values()) {
      backend.destroy?.();
    }
    this.backends.clear();
  }
}

export function createChoresRuntime(backends: readonly ChoreBackendImpl[]): ChoresRuntime {
  return new ChoreRuntimeImpl(backends);
}
