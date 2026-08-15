/**
 * Public barrel for renderer types — re-exports from `./types/RendererState`,
 * `./types/RendererContracts`, and `./types/TextureHandle` so callers don't need
 * to know that internal split. This is the intended single import point; keep it
 * in sync when the underlying `./types/*` modules change.
 */
export type {
  LayerState,
  RendererState,
  CollisionStats,
} from './types/RendererState';

export type {
  RendererBackend,
  RenderTiming,
  ExportTracerOptions,
  ExportTracerResult,
  ExportPassMode,
  ExportFrameOptions,
  ExportFrameResult,
  ChromashiftRenderer,
  ChromashiftTextureManager,
} from './types/RendererContracts';

export type {
  ChromashiftTextureHandle,
  WebGpuTextureHandle,
  WebGlTextureHandle,
  WebGLImageTexture,
} from './types/TextureHandle';

export {
  createWebGpuTextureHandle,
  createWebGlTextureHandle,
  isChromashiftTextureHandle,
  assertTextureBackend,
  webGpuTextureFromHandle,
} from './types/TextureHandle';
