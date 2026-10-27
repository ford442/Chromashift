import { createProgram, destroyProgram, type ProgramInfo } from '../../webgl/programUtils';

/** One compiled graph's programs, and the context's verdict on them. */
export interface WebGLProgramSet {
  /** Node id → its linked program. Partial when the build failed. */
  readonly programs: ReadonlyMap<string, ProgramInfo>;
  /** `null` when every program compiled and linked, otherwise the first failure's log. */
  readonly error: string | null;
}

/**
 * Program sets kept per context — a session's handful of graph variants. An
 * evicted set only drops its node → program map; the programs themselves are
 * shared by source (below) and live as long as the cache.
 */
const MAX_PROGRAM_SETS = 24;

/**
 * Every WebGL graph executor's programs on one context, keyed on the graph's
 * structural hash — the WebGL twin of `programCache.ts`.
 *
 * The main canvas and the stationary previews share a context, so they share
 * these; XR's context has a cache of its own. Unlike WebGPU, GLSL the driver
 * rejects is not deferred: compile and link status are synchronous, so a set's
 * verdict is known the moment it is built.
 *
 * Programs are shared by *source*, not by node: every band layer of a graph
 * runs one program (`u_layerIndex` picks the ramp), both accumulators run the
 * same fused pass, and a variant switched to shares most of its programs with
 * the one it replaces.
 */
export class WebGLProgramCache {
  private static readonly byContext = new WeakMap<WebGL2RenderingContext, WebGLProgramCache>();

  /** The context's cache, without taking a reference on it. */
  static for(gl: WebGL2RenderingContext): WebGLProgramCache {
    let cache = WebGLProgramCache.byContext.get(gl);
    if (!cache) {
      cache = new WebGLProgramCache(gl);
      WebGLProgramCache.byContext.set(gl, cache);
    }
    return cache;
  }

  /**
   * The context's cache, held until `release()`. Every executor retains it, so
   * a renderer torn down while its replacement is already drawing on the same
   * context (a re-run boot) cannot delete the programs the replacement uses.
   */
  static retain(gl: WebGL2RenderingContext): WebGLProgramCache {
    const cache = WebGLProgramCache.for(gl);
    cache.holders += 1;
    return cache;
  }

  private readonly gl: WebGL2RenderingContext;
  private readonly bySource = new Map<string, ProgramInfo>();
  private readonly sets = new Map<string, WebGLProgramSet>();
  private holders = 0;

  /** Programs this cache has linked, for every executor on the context together. */
  programBuildCount = 0;

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /**
   * The set for `key`, building it with `build` on a miss. `build` links
   * through `program()`, so a source another set already linked is reused;
   * `built` counts only the programs this call linked.
   *
   * A build that throws — a shader the driver will not compile, a program it
   * will not link — is remembered as a failed set rather than retried every
   * frame, exactly as a device's rejection is on WebGPU.
   */
  obtain(
    key: string,
    build: (program: (vertex: string, fragment: string) => ProgramInfo) => Map<string, ProgramInfo>,
  ): { set: WebGLProgramSet; built: number } {
    const cached = this.sets.get(key);
    if (cached) {
      // Most recently used goes last; eviction takes from the front.
      this.sets.delete(key);
      this.sets.set(key, cached);
      return { set: cached, built: 0 };
    }

    const before = this.programBuildCount;
    const programs = new Map<string, ProgramInfo>();
    let error: string | null = null;
    try {
      for (const [nodeId, info] of build((vertex, fragment) => this.program(vertex, fragment))) {
        programs.set(nodeId, info);
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const set: WebGLProgramSet = { programs, error };
    this.sets.set(key, set);
    while (this.sets.size > MAX_PROGRAM_SETS) {
      this.sets.delete(this.sets.keys().next().value!);
    }
    return { set, built: this.programBuildCount - before };
  }

  /** The linked program for this pair of sources, linking it on first use. Throws on a driver error. */
  program(vertex: string, fragment: string): ProgramInfo {
    const key = `${vertex}\u0000${fragment}`;
    let info = this.bySource.get(key);
    if (!info) {
      info = createProgram(this.gl, vertex, fragment);
      this.bySource.set(key, info);
      this.programBuildCount += 1;
    }
    return info;
  }

  /** Drop one `retain()`. The last release deletes every program the context's executors shared. */
  release(): void {
    this.holders = Math.max(0, this.holders - 1);
    if (this.holders > 0) return;
    for (const info of this.bySource.values()) destroyProgram(this.gl, info);
    this.bySource.clear();
    this.sets.clear();
    WebGLProgramCache.byContext.delete(this.gl);
  }
}
