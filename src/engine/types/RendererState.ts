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
  colorMode?           : number;
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
