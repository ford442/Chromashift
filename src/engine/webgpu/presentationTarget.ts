/**
 * Where a WebGPU renderer presents: the part of a `GPUCanvasContext` the
 * session, the orchestrator and `WebGPURenderer` actually use, so an offscreen
 * target can stand in for a canvas.
 *
 * A canvas's `getContext('webgpu')` is one as it stands. `HeadlessSurface`
 * (`src/headless/`) is the other: an offscreen texture behind the same
 * configure → `getCurrentTexture` contract. Both go through
 * `configureWebGpuCanvas`, so presenting offscreen adds no configure path of
 * its own — the surface allocates whatever format and usage that configure
 * asked for.
 */
export interface PresentationTarget {
  configure(configuration: GPUCanvasConfiguration): void;
  unconfigure(): void;
  /** The texture this frame draws into — the swap-chain image, or the offscreen target. */
  getCurrentTexture(): GPUTexture;
  /**
   * The applied configuration (Chrome 131+ on a canvas). The canvas probes
   * read it to see a dictionary member the UA dropped; absent means "can't
   * tell", and they fall back to configure-and-catch.
   */
  getConfiguration?(): GPUCanvasConfigurationOut | null;
}
