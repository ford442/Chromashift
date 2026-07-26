import type { CollisionStats } from '../../engine/types/RendererState';
import type { GpuRenderTiming } from '../../engine/types/RendererContracts';
import type { OverlayImageSource, ReferenceBlendMode } from '../../components/overlay/types';
import type { VideoExportSettings } from '../types';
import type { ChromashiftDispatch } from './types';

export function createUiActions(dispatch: ChromashiftDispatch) {
  return {
    togglePaused: () => dispatch({ type: 'ui/togglePaused' }),
    setExportingTracer: (exportingTracer: boolean) =>
      dispatch({ type: 'ui/patch', patch: { exportingTracer } }),
    setExportingVideo: (exportingVideo: boolean) =>
      dispatch({ type: 'ui/patch', patch: { exportingVideo } }),
    setVideoExportProgress: (videoExportProgress: number) =>
      dispatch({ type: 'ui/patch', patch: { videoExportProgress } }),
    patchVideoExportSettings: (patch: Partial<VideoExportSettings>) =>
      dispatch({ type: 'ui/patchVideoExport', patch }),
    setIsAutoPlayActive: (isAutoPlayActive: boolean) =>
      dispatch({ type: 'ui/patch', patch: { isAutoPlayActive } }),
    setImageChangeInterval: (imageChangeInterval: number) =>
      dispatch({ type: 'ui/patch', patch: { imageChangeInterval } }),
    setIsImageStripOpen: (isImageStripOpen: boolean) =>
      dispatch({ type: 'ui/patch', patch: { isImageStripOpen } }),
    toggleImageStrip: () => dispatch({ type: 'ui/toggleImageStrip' }),
    setReferenceBlendMode: (referenceBlendMode: ReferenceBlendMode) =>
      dispatch({ type: 'ui/patch', patch: { referenceBlendMode } }),
    setOverlayImageSource: (overlayImageSource: OverlayImageSource) =>
      dispatch({ type: 'ui/patch', patch: { overlayImageSource } }),
    setReferenceOpacity: (referenceOpacity: number) =>
      dispatch({ type: 'ui/patch', patch: { referenceOpacity } }),
    setUpscaleModel: (upscaleModel: string) =>
      dispatch({ type: 'ui/patch', patch: { upscaleModel } }),
    setUpscaleBusy: (upscaleBusy: boolean) =>
      dispatch({ type: 'ui/patch', patch: { upscaleBusy } }),
    setUpscaleProgress: (upscaleProgress: number) =>
      dispatch({ type: 'ui/patch', patch: { upscaleProgress } }),
    setUpscaleInfo: (upscaleInfo: string) =>
      dispatch({ type: 'ui/patch', patch: { upscaleInfo } }),
    setRenderCpuTiming: (renderCpuTiming: { last: number; avg: number }) =>
      dispatch({ type: 'ui/patch', patch: { renderCpuTiming } }),
    setRenderGpuTiming: (renderGpuTiming: GpuRenderTiming) =>
      dispatch({ type: 'ui/patch', patch: { renderGpuTiming } }),
    setFrameTimeHistory: (frameTimeHistory: number[]) =>
      dispatch({ type: 'ui/patch', patch: { frameTimeHistory } }),
    setPerformanceBudgetExceeded: (performanceBudgetExceeded: boolean) =>
      dispatch({ type: 'ui/patch', patch: { performanceBudgetExceeded } }),
    applyPerformanceDegrade: () => dispatch({ type: 'ui/applyPerformanceDegrade' }),
    setCollisionStats: (collisionStats: CollisionStats) =>
      dispatch({ type: 'ui/patch', patch: { collisionStats } }),
    setKioskUiHidden: (kioskUiHidden: boolean) =>
      dispatch({ type: 'ui/patch', patch: { kioskUiHidden } }),
    setKioskAttractMode: (kioskAttractMode: boolean) =>
      dispatch({ type: 'ui/patch', patch: { kioskAttractMode } }),
    setShortcutsOverlayVisible: (shortcutsOverlayVisible: boolean) =>
      dispatch({ type: 'ui/patch', patch: { shortcutsOverlayVisible } }),
  };
}
