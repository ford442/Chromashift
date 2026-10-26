/**
 * One clock for every per-frame subsystem.
 *
 * Before this there were four `requestAnimationFrame` loops — render, reactive
 * input, live-source upload, WebXR — each scheduled independently, so whether
 * the render loop saw this frame's audio modulation or last frame's depended on
 * which React effect happened to register first. Now each subsystem registers
 * a task in a named phase and the clock runs the phases in a fixed order:
 *
 *   input → sources → modulate → render → telemetry
 *
 * - **input**: sample MIDI / audio / OSC.
 * - **sources**: upload live video frames.
 * - **modulate**: compute this frame's parameter values and animation angles.
 * - **render**: draw each output (main canvas, compare slot, headset).
 * - **telemetry**: publish timings and meters (throttled by the task itself).
 *
 * Within a phase, tasks run in registration order; nothing should depend on
 * that — anything a later phase needs belongs in an earlier phase.
 *
 * A subsystem that is off **unregisters**; it does not stay registered as a
 * no-op. With no tasks the clock requests no frames at all.
 *
 * The clock has two modes. `realtime` is driven by a {@link FrameScheduler}
 * (the window's `requestAnimationFrame`, or an XR session's while immersive).
 * `offline` requests nothing; the caller advances it with {@link FrameClock.step}
 * and a fixed `dt`, and awaits each task — so offline video export runs the
 * same phases in the same order as the live session.
 */

export const FRAME_PHASES = ['input', 'sources', 'modulate', 'render', 'telemetry'] as const;
export type FramePhase = (typeof FRAME_PHASES)[number];

export type FrameClockMode = 'realtime' | 'offline';

export interface FrameTick {
  /** Timestamp in ms: the scheduler's in realtime, synthetic (`start + Σdt`) offline. */
  now: number;
  /** ms since the previous tick; 0 on the first tick after a (re)start. */
  dt: number;
  /** Ticks since the clock was created. */
  index: number;
  mode: FrameClockMode;
  /** The XR frame when an XR session is driving the clock, else null. */
  xrFrame: XRFrame | null;
}

/**
 * A per-frame task. Realtime ticks never await a returned promise (a frame
 * cannot wait); offline steps await each one before the next task runs.
 */
export type FrameTask = (tick: FrameTick) => void | Promise<void>;

/** Something that calls back once per display (or headset) frame. */
export interface FrameScheduler {
  request(callback: (now: number, xrFrame?: XRFrame) => void): number;
  cancel(handle: number): void;
}

export const windowFrameScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame((now) => callback(now)),
  cancel: (handle) => cancelAnimationFrame(handle),
};

interface Entry {
  task: FrameTask;
  label: string;
  active: boolean;
}

export interface FrameClockOptions {
  scheduler?: FrameScheduler;
  /** Where a realtime task's exception goes; the other tasks still run. */
  onError?: (error: unknown, phase: FramePhase, label: string) => void;
}

function reportTaskError(error: unknown, phase: FramePhase, label: string): void {
  console.error(`[chromashift] frame task "${label}" (${phase}) threw`, error);
}

export class FrameClock {
  private readonly phases = new Map<FramePhase, Entry[]>(FRAME_PHASES.map((phase) => [phase, []]));
  private readonly onError: NonNullable<FrameClockOptions['onError']>;
  private scheduler: FrameScheduler;
  private pending: number | null = null;
  private lastNow: number | null = null;
  private index = 0;
  private offlineDepth = 0;
  private offlineNow = 0;
  private stepping = false;

  constructor(options: FrameClockOptions = {}) {
    this.scheduler = options.scheduler ?? windowFrameScheduler;
    this.onError = options.onError ?? reportTaskError;
  }

  get mode(): FrameClockMode {
    return this.offlineDepth > 0 ? 'offline' : 'realtime';
  }

  /** Registered tasks, across phases. */
  get size(): number {
    let count = 0;
    for (const entries of this.phases.values()) count += entries.length;
    return count;
  }

  /** Labels per phase, in run order — for diagnostics and tests. */
  describe(): Record<FramePhase, string[]> {
    return Object.fromEntries(
      FRAME_PHASES.map((phase) => [phase, this.phases.get(phase)!.map((entry) => entry.label)]),
    ) as Record<FramePhase, string[]>;
  }

  /**
   * Run `task` in `phase` every tick from the next one on. Returns the
   * unregister function; calling it mid-tick skips the task for the rest of
   * that tick.
   */
  register(phase: FramePhase, task: FrameTask, label = task.name || 'anonymous'): () => void {
    const entry: Entry = { task, label, active: true };
    this.phases.get(phase)!.push(entry);
    this.schedule();
    return () => this.remove(phase, entry);
  }

  private remove(phase: FramePhase, entry: Entry): void {
    if (!entry.active) return;
    entry.active = false;
    const entries = this.phases.get(phase)!;
    entries.splice(entries.indexOf(entry), 1);
    if (this.size === 0) this.cancelPending();
  }

  /**
   * Drive realtime ticks from `scheduler` (an XR session's frame loop) until
   * the returned function restores the previous one.
   */
  useScheduler(scheduler: FrameScheduler): () => void {
    const previous = this.scheduler;
    this.swapScheduler(scheduler);
    return () => {
      if (this.scheduler === scheduler) this.swapScheduler(previous);
    };
  }

  private swapScheduler(scheduler: FrameScheduler): void {
    this.cancelPending();
    this.scheduler = scheduler;
    this.lastNow = null;
    this.schedule();
  }

  /**
   * Switch to offline mode (nestable). Realtime frames stop until the
   * returned function is called; offline time starts at `startNow`.
   */
  enterOffline(startNow = 0): () => void {
    if (this.offlineDepth === 0) {
      this.cancelPending();
      this.offlineNow = startNow;
    }
    this.offlineDepth += 1;
    let exited = false;
    return () => {
      if (exited) return;
      exited = true;
      this.offlineDepth -= 1;
      if (this.offlineDepth === 0) {
        this.lastNow = null;
        this.schedule();
      }
    };
  }

  /** Advance an offline clock by `dt` ms, running every phase and awaiting each task. */
  async step(dt: number): Promise<FrameTick> {
    if (this.mode !== 'offline') throw new Error('FrameClock.step() needs offline mode (enterOffline).');
    if (this.stepping) throw new Error('FrameClock.step() called while a step is still running.');
    this.stepping = true;
    try {
      this.offlineNow += dt;
      const tick = this.nextTick(this.offlineNow, dt, null);
      for (const [, entries] of this.snapshot()) {
        for (const entry of entries) {
          if (entry.active) await entry.task(tick);
        }
      }
      return tick;
    } finally {
      this.stepping = false;
    }
  }

  /**
   * Every phase's tasks as of the start of a tick, so a task registered
   * mid-tick (in any phase) first runs on the next one.
   */
  private snapshot(): [FramePhase, Entry[]][] {
    return FRAME_PHASES.map((phase) => [phase, [...this.phases.get(phase)!]]);
  }

  private nextTick(now: number, dt: number, xrFrame: XRFrame | null): FrameTick {
    const tick: FrameTick = { now, dt, index: this.index, mode: this.mode, xrFrame };
    this.index += 1;
    return tick;
  }

  private schedule(): void {
    if (this.pending !== null || this.mode !== 'realtime' || this.size === 0) return;
    const scheduler = this.scheduler;
    this.pending = scheduler.request((now, xrFrame) => {
      // A frame requested on a scheduler that was since swapped out is stale.
      if (scheduler !== this.scheduler) return;
      this.pending = null;
      this.runRealtime(now, xrFrame ?? null);
    });
  }

  private cancelPending(): void {
    if (this.pending === null) return;
    this.scheduler.cancel(this.pending);
    this.pending = null;
  }

  private runRealtime(now: number, xrFrame: XRFrame | null): void {
    if (this.mode !== 'realtime') return;
    const dt = this.lastNow === null ? 0 : now - this.lastNow;
    this.lastNow = now;
    const tick = this.nextTick(now, dt, xrFrame);
    for (const [phase, entries] of this.snapshot()) {
      for (const entry of entries) {
        if (!entry.active) continue;
        try {
          // Realtime never waits on a task, but a rejection is still reported.
          const result = entry.task(tick);
          if (result) result.catch((error: unknown) => this.onError(error, phase, entry.label));
        } catch (error) {
          this.onError(error, phase, entry.label);
        }
      }
    }
    this.schedule();
  }
}
