/** @deprecated Import from `./types/RendererState` or `./types/RendererContracts` instead. */
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
