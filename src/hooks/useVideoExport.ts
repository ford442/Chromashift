import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { detectVideoCodecSupport, probeVideoExportCapabilities, type VideoCodecSupport } from '../engine/videoExport/videoCodecs';
import type { VideoExportContainer, VideoExportQuality } from '../state/types';
import type { ExportPassMode } from '../engine/types/RendererContracts';
import type { ChromashiftRefs, ChromashiftStore } from './useChromashiftStore';

export function useVideoExport(refs: ChromashiftRefs, store: ChromashiftStore) {
  const { state, actions } = store;
  const { rendererRef, mainCanvasRef, animAnglesRef } = refs;
  const abortRef = useRef<AbortController | null>(null);

  const syncCodecSupport = useMemo(() => detectVideoCodecSupport(), []);
  const [codecSupport, setCodecSupport] = useState<VideoCodecSupport>(syncCodecSupport);

  useEffect(() => {
    const mainCanvas = mainCanvasRef.current;
    const baseWidth = Math.max(1, Math.round(mainCanvas?.width ?? 1024));
    const baseHeight = Math.max(1, Math.round(mainCanvas?.height ?? 1024));
    const scale = state.ui.videoExportSettings.resolutionScale;
    const probeWidth = Math.max(2, Math.round(baseWidth * scale));
    const probeHeight = Math.max(2, Math.round(baseHeight * scale));

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void probeVideoExportCapabilities(probeWidth, probeHeight).then((caps) => {
        if (!cancelled) setCodecSupport(caps);
      });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mainCanvasRef, state.ui.videoExportSettings.resolutionScale]);

  const handleCancelVideoExport = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleExportVideo = useCallback(async () => {
    const renderer = rendererRef.current;
    if (!renderer || state.ui.exportingVideo) return;

    const settings = state.ui.videoExportSettings;
    const mainCanvas = mainCanvasRef.current;
    const baseWidth = Math.max(1, Math.round(mainCanvas?.width ?? 1024));
    const baseHeight = Math.max(1, Math.round(mainCanvas?.height ?? 1024));

    const wasAutoPlay = state.ui.isAutoPlayActive;
    const wasPaused = state.engine.paused;

    abortRef.current = new AbortController();
    actions.setExportingVideo(true);
    actions.setVideoExportProgress(0);
    actions.setIsAutoPlayActive(false);
    actions.setIsPaused(true);

    try {
      const { downloadVideoExport, exportVideo } = await import('../engine/videoExport/VideoExporter');
      const result = await exportVideo(
        renderer,
        state,
        animAnglesRef.current,
        baseWidth,
        baseHeight,
        {
          ...settings,
          signal: abortRef.current.signal,
          onProgress: (frame, total) => {
            actions.setVideoExportProgress(frame / total);
          },
        },
      );
      downloadVideoExport(result);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      console.error('Video export failed:', error);
      alert(error instanceof Error ? error.message : 'Video export failed.');
    } finally {
      abortRef.current = null;
      actions.setExportingVideo(false);
      actions.setVideoExportProgress(0);
      actions.setIsAutoPlayActive(wasAutoPlay);
      actions.setIsPaused(wasPaused);
    }
  }, [rendererRef, mainCanvasRef, animAnglesRef, state, actions]);

  const patchVideoExportSettings = actions.patchVideoExportSettings;

  return {
    codecSupport,
    exportingVideo: state.ui.exportingVideo,
    videoExportProgress: state.ui.videoExportProgress,
    videoExportSettings: state.ui.videoExportSettings,
    handleExportVideo,
    handleCancelVideoExport,
    onVideoExportDurationChange: (durationSec: number) => patchVideoExportSettings({ durationSec }),
    onVideoExportFpsChange: (fps: number) => patchVideoExportSettings({ fps }),
    onVideoExportScaleChange: (resolutionScale: number) => patchVideoExportSettings({ resolutionScale }),
    onVideoExportIncludeTracersChange: (includeTracers: boolean) => patchVideoExportSettings({ includeTracers }),
    onVideoExportPassModeChange: (passMode: ExportPassMode) => patchVideoExportSettings({ passMode }),
    onVideoExportFilenameChange: (filename: string) => patchVideoExportSettings({ filename }),
    onVideoExportUsePresetAnglesChange: (usePreset: boolean) => patchVideoExportSettings({ usePresetAngles: usePreset }),
    onVideoExportContainerChange: (container: VideoExportContainer) => patchVideoExportSettings({ container }),
    onVideoExportQualityChange: (quality: VideoExportQuality) => patchVideoExportSettings({ quality }),
  };
}
