import type { NodeProgram } from './nodePipelines';

/** One compiled graph's programs at one sample count and pair of formats, and the device's verdict. */
export interface ProgramSet {
  readonly programs: ReadonlyMap<string, NodeProgram>;
  /** `null` until the device has answered. */
  valid: boolean | null;
  /** `null` when every program validated, otherwise the device's first error. */
  readonly verdict: Promise<string | null>;
}

/**
 * Program sets kept per device: a session's handful of graph variants, times
 * the renderers drawing them, all share these. Pipelines have no `destroy()`,
 * so an evicted set is simply dropped.
 */
const MAX_PROGRAM_SETS = 24;

/**
 * Every executor's compiled programs on one device, keyed on the graph's
 * structural hash (plus the sample count and formats that also shape a
 * pipeline).
 *
 * The main canvas, the compare slot, the quad cells and the stationary
 * previews each own an executor — their pools, buffers and bind groups are
 * their own — but they mostly draw the same graph, and compiling and
 * validating its shaders once instead of once per renderer is what makes
 * opening a compare layout cheap. A set built for one executor is ready for
 * the next, verdict and all.
 */
export class GraphProgramCache {
  private static readonly byDevice = new WeakMap<GPUDevice, GraphProgramCache>();

  static for(device: GPUDevice): GraphProgramCache {
    let cache = GraphProgramCache.byDevice.get(device);
    if (!cache) {
      cache = new GraphProgramCache(device);
      GraphProgramCache.byDevice.set(device, cache);
    }
    return cache;
  }

  private readonly device: GPUDevice;
  private readonly sets = new Map<string, ProgramSet>();

  /** Programs this cache has compiled, for every executor on the device together. */
  programBuildCount = 0;

  private constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * The set for `key`, compiling it with `build` on a miss. `built` is how many
   * programs this call compiled — zero on a hit.
   *
   * Every object a build creates is created inside a validation and an
   * internal error scope, with nothing else between the push and the pops, so
   * an error they catch belongs to this set: invalid WGSL is not an exception
   * in WebGPU, and the verdict is how a caller learns of it before a frame
   * binds the pipeline and the queue drops the whole command buffer.
   */
  obtain(key: string, build: () => Map<string, NodeProgram>): { set: ProgramSet; built: number } {
    const cached = this.sets.get(key);
    if (cached) {
      // Most recently used goes last; eviction takes from the front.
      this.sets.delete(key);
      this.sets.set(key, cached);
      return { set: cached, built: 0 };
    }

    // Filled in once the build returns; a build that throws leaves no set behind.
    const set: { programs: Map<string, NodeProgram>; valid: boolean | null; verdict: Promise<string | null> } = {
      programs: new Map(),
      valid: null,
      verdict: Promise.resolve(null),
    };
    this.device.pushErrorScope('internal');
    this.device.pushErrorScope('validation');
    try {
      set.programs = build();
    } finally {
      const validation = this.device.popErrorScope();
      const internal = this.device.popErrorScope();
      set.verdict = Promise.all([validation, internal]).then(([invalid, failed]) => {
        const error = invalid ?? failed;
        set.valid = error === null;
        return error ? error.message : null;
      });
    }
    const programs = set.programs;
    this.programBuildCount += programs.size;
    this.sets.set(key, set);
    while (this.sets.size > MAX_PROGRAM_SETS) {
      this.sets.delete(this.sets.keys().next().value!);
    }
    return { set, built: programs.size };
  }
}
