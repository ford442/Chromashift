import type { MainViewMode } from '../../engine/viewModes';
import type { ChromashiftDispatch } from './types';

export function createOutputActions(dispatch: ChromashiftDispatch) {
  return {
    setSquareCanvas: (squareCanvas: boolean) =>
      dispatch({ type: 'output/patch', patch: { squareCanvas } }),
    setAntialiasEnabled: (antialiasEnabled: boolean) =>
      dispatch({ type: 'output/patch', patch: { antialiasEnabled } }),
    setOutputMode: (outputMode: number) =>
      dispatch({ type: 'output/patch', patch: { outputMode } }),
    setDiagnosticsMode: (diagnosticsMode: boolean) =>
      dispatch({ type: 'output/patch', patch: { diagnosticsMode } }),
    setDiagnosticsOpacity: (diagnosticsOpacity: number) =>
      dispatch({ type: 'output/patch', patch: { diagnosticsOpacity } }),
    setStampBoost: (stampBoost: number) =>
      dispatch({ type: 'output/patch', patch: { stampBoost } }),
    setPeakCollisionsOnly: (peakCollisionsOnly: boolean) =>
      dispatch({ type: 'output/patch', patch: { peakCollisionsOnly } }),
    setWebglDebugMode: (webglDebugMode: number) =>
      dispatch({ type: 'output/patch', patch: { webglDebugMode } }),
    setMainViewMode: (mainViewMode: MainViewMode) =>
      dispatch({ type: 'output/patch', patch: { mainViewMode } }),
    setTracerInspectZoom: (zoom: number) =>
      dispatch({ type: 'output/patchInspect', patch: { zoom } }),
    setTracerInspectPan: (pan: { x: number; y: number }) =>
      dispatch({ type: 'output/patchInspect', patch: { pan } }),
    setTracerInspectHeatmap: (heatmap: boolean) =>
      dispatch({ type: 'output/patchInspect', patch: { heatmap } }),
    setTracerInspectExposure: (exposure: number) =>
      dispatch({ type: 'output/patchInspect', patch: { exposure } }),
    setTracerInspectTonemap: (tonemap: boolean) =>
      dispatch({ type: 'output/patchInspect', patch: { tonemap } }),
    setTracerInspectShowLayers: (showLayers: boolean) =>
      dispatch({ type: 'output/patchInspect', patch: { showLayers } }),
    resetInspectView: () => dispatch({ type: 'output/resetInspectView' }),
    setViewportQuarterZoom: (viewportQuarterZoom: boolean) =>
      dispatch({ type: 'output/patch', patch: { viewportQuarterZoom } }),
    setViewportHalfOverlay: (viewportHalfOverlay: boolean) =>
      dispatch({ type: 'output/patch', patch: { viewportHalfOverlay } }),
    setTracerPreviewFrozen: (tracerPreviewFrozen: boolean) =>
      dispatch({ type: 'output/patch', patch: { tracerPreviewFrozen } }),
    setLivePreviewEnabled: (livePreviewEnabled: boolean) =>
      dispatch({ type: 'output/patch', patch: { livePreviewEnabled } }),
    setPerformanceHudEnabled: (performanceHudEnabled: boolean) =>
      dispatch({ type: 'output/patch', patch: { performanceHudEnabled } }),
    setPerformanceAutoDegrade: (performanceAutoDegrade: boolean) =>
      dispatch({ type: 'output/patch', patch: { performanceAutoDegrade } }),
  };
}
