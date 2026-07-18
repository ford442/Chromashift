import { useCallback, useRef, useState } from 'react';
import { NunifOverlay } from './NunifOverlay';
import { MainViewport } from './MainViewport';
import { PreviewStrip } from './PreviewStrip';
import { ChromeShell } from './ChromeShell';
import { buildOverlayProps } from './buildOverlayProps';
import { collectImageFilesFromDataTransfer } from '../engine/fileDrop';
import type { AppUIProps } from './AppUI.types';

export function AppUI(props: AppUIProps) {
  const {
    containerRef,
    mainViewportRef,
    previewTracerRef,
    canvasBRef,
    overlaySeparatedRef,
    previewOriginalRef,
    previewSeparatedRef,
    canvasRef,
    photoModeImage,
    isReferenceCompareMode,
    referenceImage,
    showCanvasMainView,
    isPaused,
    mainViewMode,
    showImageOverlay,
    overlayImageSource,
    overlayPhotoImage,
    overlayUsesSeparatedCanvas,
    referenceBlendMode,
    referenceOpacity,
    compareDualActive,
    compareSlotBLabel,
    tracerPreviewFrozen,
    setTracerPreviewFrozen,
    livePreviewEnabled,
    setLivePreviewEnabled,
    gpuError,
    collisionStats,
    avgLuminance,
    engineMode,
    wasmAvailable,
    renderCpuTiming,
    performanceHudEnabled,
    imageList,
    currentImageIndex,
    isImageStripOpen,
    specificImageError,
    kioskEnabled,
    kioskUiHidden,
    shortcutsOverlayVisible,
    kioskFullscreen,
    selectSourceIndex,
    setIsPaused,
    toggleImageStrip,
    setMainViewMode,
    setReferenceImage,
    handleClearLocalLibrary,
    setAvgLuminance,
    setShortcutsOverlayVisible,
    toggleKioskFullscreen,
    setSpecificImageError,
    handleDropFiles,
  } = props;

  const showChrome = !kioskEnabled || !kioskUiHidden;
  const showKioskRemote = kioskEnabled && kioskUiHidden;

  const [isDragActive, setIsDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragActive(false);
    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return;
    void collectImageFilesFromDataTransfer(dataTransfer).then((files) => {
      if (files.length > 0) void handleDropFiles(files);
    });
  }, [handleDropFiles]);

  return (
    <div
      ref={containerRef}
      className={`relative w-screen h-screen bg-gradient-to-br from-gray-900 via-amber-950 to-black overflow-hidden ${
        kioskEnabled ? 'kiosk-mode' : ''
      }`}
      id="chromashift-container"
      onDragOver={showChrome ? handleDragOver : undefined}
      onDragEnter={showChrome ? handleDragEnter : undefined}
      onDragLeave={showChrome ? handleDragLeave : undefined}
      onDrop={showChrome ? handleDrop : undefined}
      onClick={() => {
        if (showKioskRemote && !kioskFullscreen) {
          void toggleKioskFullscreen();
        }
      }}
    >
      {showChrome && isDragActive && (
        <div className="absolute inset-0 z-[100] pointer-events-none flex items-center justify-center bg-black/60 border-4 border-dashed border-amber-400">
          <div className="text-amber-200 font-mono text-lg px-6 py-3 rounded-xl bg-black/70 border border-amber-400/50">
            Drop images or folders to add to your local library
          </div>
        </div>
      )}

      <MainViewport
        mainViewportRef={mainViewportRef}
        previewTracerRef={previewTracerRef}
        canvasBRef={canvasBRef}
        overlaySeparatedRef={overlaySeparatedRef}
        photoModeImage={photoModeImage}
        isReferenceCompareMode={isReferenceCompareMode}
        referenceImage={referenceImage}
        showCanvasMainView={showCanvasMainView}
        isPaused={isPaused}
        mainViewMode={mainViewMode}
        showImageOverlay={showImageOverlay}
        overlayImageSource={overlayImageSource}
        overlayPhotoImage={overlayPhotoImage}
        overlayUsesSeparatedCanvas={overlayUsesSeparatedCanvas}
        referenceBlendMode={referenceBlendMode}
        referenceOpacity={referenceOpacity}
        compareDualActive={compareDualActive}
        compareSlotBLabel={compareSlotBLabel}
      />

      {showChrome && (
        <PreviewStrip
          previewOriginalRef={previewOriginalRef}
          previewSeparatedRef={previewSeparatedRef}
          canvasRef={canvasRef}
          tracerPreviewFrozen={tracerPreviewFrozen}
          setTracerPreviewFrozen={setTracerPreviewFrozen}
          livePreviewEnabled={livePreviewEnabled}
          setLivePreviewEnabled={setLivePreviewEnabled}
        />
      )}

      <ChromeShell
        showChrome={showChrome}
        showKioskRemote={showKioskRemote}
        gpuError={gpuError}
        collisionStats={collisionStats}
        avgLuminance={avgLuminance}
        engineMode={engineMode}
        wasmAvailable={wasmAvailable}
        renderCpuTiming={renderCpuTiming}
        performanceHudEnabled={performanceHudEnabled}
        imageList={imageList}
        currentImageIndex={currentImageIndex}
        referenceImage={referenceImage}
        isImageStripOpen={isImageStripOpen}
        isPaused={isPaused}
        specificImageError={specificImageError}
        kioskEnabled={kioskEnabled}
        kioskUiHidden={kioskUiHidden}
        shortcutsOverlayVisible={shortcutsOverlayVisible}
        kioskFullscreen={kioskFullscreen}
        selectSourceIndex={selectSourceIndex}
        setIsPaused={setIsPaused}
        toggleImageStrip={toggleImageStrip}
        setMainViewMode={setMainViewMode}
        setReferenceImage={setReferenceImage}
        handleClearLocalLibrary={handleClearLocalLibrary}
        setAvgLuminance={setAvgLuminance}
        setShortcutsOverlayVisible={setShortcutsOverlayVisible}
        toggleKioskFullscreen={toggleKioskFullscreen}
        setSpecificImageError={setSpecificImageError}
      />

      {showChrome && <NunifOverlay {...buildOverlayProps(props)} />}
    </div>
  );
}
