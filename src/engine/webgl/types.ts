export interface WebGLRenderViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The framebuffer the composite lands in, when it is not the canvas — an
   * `XRWebGLLayer`'s, which holds every eye side by side.
   */
  framebuffer?: WebGLFramebuffer | null;
}
