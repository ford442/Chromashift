/**
 * Live-view resolution budget for the WebGL2 diagnostic backend.
 *
 * A synchronous `readPixels` (and, on some drivers, the draws themselves)
 * drains every pass queued that frame, and that cost scales with pixel count.
 * On SwiftShader a 1280² frame flushed by a 64×64 read was ~570 ms of main-thread
 * time; the same frame with the read parked in a pixel-pack buffer was < 1 ms.
 * Capping the long edge, then stepping down while a frame still misses its
 * budget, keeps a machine without a usable WebGPU adapter interactive.
 *
 * Export and WebXR pass an explicit viewport and do not use this controller.
 */

/** Longest internal edge before the live view starts upscaling to the canvas. */
export const WEBGL_INTERNAL_EDGE_CAP = 960;

/** Floor so a slow machine still has a recognisable diagnostic image. */
export const WEBGL_INTERNAL_EDGE_MIN = 480;

/** Ignore the first frames at a size — texture allocation is not a steady state. */
export const WEBGL_SCALE_WARMUP_FRAMES = 15;

/** Consecutive over-budget frames before the internal edge steps down. */
export const WEBGL_SCALE_OVER_FRAMES = 6;

/** Consecutive comfortable frames before the internal edge steps back up. */
export const WEBGL_SCALE_UNDER_FRAMES = 45;

export interface WebglScaleController {
  scale: number;
  over: number;
  under: number;
  frames: number;
  anchorEdge: number;
}

export function createWebglScaleController(): WebglScaleController {
  return { scale: 1, over: 0, under: 0, frames: 0, anchorEdge: 0 };
}

/** Scale that keeps `max(width, height)` at `edgeCap`, or 1 when already inside it. */
export function webglBaseInternalScale(
  width: number,
  height: number,
  edgeCap = WEBGL_INTERNAL_EDGE_CAP,
): number {
  const edge = Math.max(1, width, height);
  if (edge <= edgeCap) return 1;
  return edgeCap / edge;
}

function edgeFloor(width: number, height: number): number {
  const edge = Math.max(1, width, height);
  return Math.min(1, WEBGL_INTERNAL_EDGE_MIN / edge);
}

/**
 * Scale for the frame about to be drawn.
 *
 * `elapsedMs` is the previous frame's main-thread time (`null` on the first
 * frame at this size). The controller resets when the canvas edge changes.
 */
export function stepWebglInternalScale(
  controller: WebglScaleController,
  width: number,
  height: number,
  elapsedMs: number | null,
  budgetMs: number,
): number {
  const edge = Math.max(1, width, height);
  const base = webglBaseInternalScale(width, height);
  const floor = edgeFloor(width, height);
  if (controller.anchorEdge !== edge) {
    controller.anchorEdge = edge;
    controller.scale = Math.max(floor, base);
    controller.over = 0;
    controller.under = 0;
    controller.frames = 0;
    return controller.scale;
  }

  controller.frames += 1;
  if (elapsedMs === null || controller.frames <= WEBGL_SCALE_WARMUP_FRAMES) {
    return controller.scale;
  }

  const over = elapsedMs > budgetMs * 1.15;
  const under = elapsedMs < budgetMs * 0.45 && controller.scale < base - 1e-3;
  controller.over = over ? controller.over + 1 : 0;
  controller.under = under ? controller.under + 1 : 0;

  if (controller.over >= WEBGL_SCALE_OVER_FRAMES) {
    const next = Math.max(floor, Math.round(controller.scale * 0.75 * 100) / 100);
    if (next < controller.scale - 1e-3) controller.scale = next;
    controller.over = 0;
    controller.under = 0;
  } else if (controller.under >= WEBGL_SCALE_UNDER_FRAMES) {
    const raised = Math.round((controller.scale / 0.75) * 100) / 100;
    controller.scale = Math.min(base, Math.max(floor, raised));
    controller.over = 0;
    controller.under = 0;
  }

  return controller.scale;
}
