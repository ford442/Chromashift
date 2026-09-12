export interface LayerState {
  angleDeg : number;
  flipX?   : boolean;
  flipY?   : boolean;
}

export interface RendererState {
  layers               : [LayerState, LayerState, LayerState];
  avgLuminance         : number;
  layerOpacity?        : number;
  layerOpacities?      : [number, number, number];
  layerScale?          : number;
  tracerScale?         : number;
  tracerAboveIntensity?: number;
  tracerBelowIntensity?: number;
  tracerAboveDuration? : number;
  tracerBelowDuration? : number;
  tracerThreshold?     : number;
  tracerMode?          : number;
  /**
   * Temporal tracer term as a `MotionMode` index (see `engine/motionModes.ts`):
   * 0 = off, 1 = boost, 2 = gate, 3 = direction. 0 keeps the renderers on the
   * pre-motion shaders and pipelines. See `docs/LIVE_SOURCE.md`.
   */
  motionMode?          : number;
  /** How strongly motion boosts a fresh stamp. */
  motionGain?          : number;
  /** How much motion slows local decay (0 = none, 1 = fully held). */
  motionDecayBias?     : number;
  /** Noise floor applied when the motion field is produced, in [0,1). */
  motionThreshold?     : number;
  colorMode?           : number;
  /**
   * Baked colour-profile LUT (256×3 RGBA8, see `buildColorProfileLut`). Present
   * only when a non-classic profile is active; renderers upload it when the
   * array identity changes. `null`/absent keeps the classic branchy path.
   */
  colorProfileLut?     : Uint8Array | null;
  /** 1 = sample the LUT instead of the classic band branches. */
  colorProfileMode?    : number;
  /** 1 = lift luminance by the classic lightDark term before LUT lookup. */
  colorProfileLightDark?: number;
  sobelEnabled?        : boolean;
  softCropEnabled?     : boolean;
  layerBlendMode?      : number;
  tracerBlendMode?     : number;
  outputMode?          : number;
  paused?              : boolean;
  showTracerView?      : boolean;
  mainViewMode?        : number;
  tracerInspectZoom?   : number;
  tracerInspectPanX?   : number;
  tracerInspectPanY?   : number;
  tracerInspectHeatmap?: boolean;
  tracerInspectExposure? : number;
  tracerInspectTonemap?: boolean;
  tracerInspectShowLayers?: boolean;
  diagnosticsMode?     : boolean;
  diagnosticsOpacity?  : number;
  stampBoost?          : number;
  peakCollisionsOnly?  : boolean;
  webglDebugMode?      : number;
  viewportQuarterZoom? : boolean;
  viewportHalfOverlay? : boolean;
  halfOverlayAlpha?    : number;
  livePreviewEnabled?  : boolean;
  /** When true, WebGPU timestamp queries are written and resolved (Perf HUD). */
  profilePerformance?: boolean;
}

export interface CollisionStats {
  sampledPixels: number;
  twoOverlapPixels: number;
  threeOverlapPixels: number;
  dominantLayerWins: [number, number, number];
  averageCollision: number;
}
