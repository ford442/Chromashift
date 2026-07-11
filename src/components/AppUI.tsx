/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useRef, useState } from 'react';
import { ImageStrip } from './ImageStrip';
import { KioskRemote } from './KioskRemote';
import { NunifOverlay } from './NunifOverlay';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { switchRendererPreference } from '../engine/rendererMode';
import { collectImageFilesFromDataTransfer } from '../engine/fileDrop';

export function AppUI(props: any) {
  const {
    containerRef, mainViewportRef, previewTracerRef, photoModeImage, isReferenceCompareMode,
    handleDropFiles, handleClearLocalLibrary,
    referenceImage, showCanvasMainView, isPaused, mainViewMode, showReferenceOverlay,
    referenceBlendMode, referenceOpacity, previewOriginalRef, previewSeparatedRef, gpuError,
    rendererBackend, rendererFallbackReason, webglDebugMode, setWebglDebugMode,
    collisionStats, isAutoPlayActive, setIsAutoPlayActive, isImageStripOpen,
    setIsImageStripOpen, imageList, currentImageIndex, selectSourceIndex, handleLoadFile,
    handleLoadSpecificImage, handleLoadReferenceFile, setReferenceImage, swapSourceAndReference,
    setReferenceBlendMode, setReferenceOpacity, handleFreezeInspect, tracerInspectZoom,
    setTracerInspectZoom, tracerInspectHeatmap, setTracerInspectHeatmap,
    tracerInspectExposure, setTracerInspectExposure, tracerInspectTonemap, setTracerInspectTonemap,
    tracerInspectShowLayers, setTracerInspectShowLayers, handleResetInspectView, exportingTracer,
    handleExportTracer, layerAngles, handleAngleChange, layerExtensions, handleExtensionChange,
    frameRate, setFrameRate, layerOpacity, setLayerOpacity, layerOpacities,
    setLayerOpacities, layerScale, setLayerScale, tracerScale, setTracerScale, tracerAboveIntensity,
    setTracerAboveIntensity, tracerBelowIntensity, setTracerBelowIntensity, tracerAboveDuration,
    setTracerAboveDuration, tracerBelowDuration, setTracerBelowDuration, tracerMode, setTracerMode,
    layerBlendMode, setLayerBlendMode, tracerBlendMode, setTracerBlendMode, outputMode, setOutputMode,
    diagnosticsMode, setDiagnosticsMode, diagnosticsOpacity, setDiagnosticsOpacity, stampBoost,
    setStampBoost, peakCollisionsOnly, setPeakCollisionsOnly, colorMode, setColorMode, squareCanvas,
    performanceHudEnabled, setPerformanceHudEnabled, performanceAutoDegrade, setPerformanceAutoDegrade,
    performanceBudgetExceeded, renderGpuTiming, frameTimeHistory, applyPerformanceDegrade,
    setSobelEnabled, sobelEnabled, setSoftCropEnabled, softCropEnabled, viewportQuarterZoom,
    setViewportQuarterZoom, viewportHalfOverlay, setViewportHalfOverlay, setSquareCanvas,
    antialiasEnabled, setAntialiasEnabled, handleReset, imageChangeInterval,
    setImageChangeInterval, upscaleModel, setUpscaleModel, handleUpscaleSource, handleUpscaleOutput,
    upscaleBusy, upscaleProgress, upscaleInfo, engineMode, setEngineMode, wasmAvailable,
    specificImageError, renderCpuTiming, avgLuminance, canvasRef, setTracerPreviewFrozen,
    tracerPreviewFrozen, setLivePreviewEnabled, livePreviewEnabled, setIsPaused, setMainViewMode,
    setAvgLuminance, isViewingTracer, currentImage, rendererRef, handleLoadReferenceImage,
    isWasmReady, setSpecificImageError,
    builtinPresets, savedPresets, presetStatus, presetError,
    handleSavePreset, handleLoadPreset, handleDeletePreset, handleApplyBuiltinPreset,
    handleCopyPresetUrl, handleExportPresetFile, handleImportPresetFile,
    exportingVideo, videoExportProgress, videoExportSettings, codecSupport,
    handleExportVideo, handleCancelVideoExport,
    onVideoExportDurationChange, onVideoExportFpsChange, onVideoExportScaleChange,
    onVideoExportIncludeTracersChange, onVideoExportPassModeChange, onVideoExportFilenameChange,
    onVideoExportUsePresetAnglesChange,
    kioskEnabled,
    kioskUiHidden,
    shortcutsOverlayVisible,
    setShortcutsOverlayVisible,
    kioskFullscreen,
    toggleKioskFullscreen,
    reactiveEnabled,
    audioEnabled,
    midiEnabled,
    micActive,
    micError,
    midiAvailable,
    midiError,
    midiLearnTarget,
    midiBindings,
    audioLevels,
    audioSensitivity,
    layerExtension0,
    onReactiveEnabledChange,
    onAudioEnabledChange,
    onMidiEnabledChange,
    onAudioSensitivityChange,
    onStartMicDemo,
    onMidiLearnTargetChange,
    onRemoveMidiBinding,
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
  }, [dragDepthRef]);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragActive(false);
  }, [dragDepthRef]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragActive(false);
    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return;
    void collectImageFilesFromDataTransfer(dataTransfer).then((files) => {
      if (files.length > 0) void handleDropFiles(files);
    });
  }, [dragDepthRef, handleDropFiles]);

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
      {/* Main display viewport */}
      <div
        ref={mainViewportRef}
        style={{ position: 'absolute' }}
      >
        <canvas
          ref={previewTracerRef}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            imageRendering: 'auto',
            display: showCanvasMainView ? 'block' : 'none',
            background: '#000',
            cursor: isPaused && mainViewMode === MAIN_VIEW_MODES.FULL_RES_TRACER ? 'grab' : 'default',
            clipPath: isReferenceCompareMode ? 'inset(0 50% 0 0)' : 'none',
          }}
        />
        {(photoModeImage || isReferenceCompareMode) && (
          <div
            className="absolute inset-0 overflow-hidden bg-black"
            style={{ clipPath: isReferenceCompareMode ? 'inset(0 0 0 50%)' : 'none' }}
          >
            <img
              src={(isReferenceCompareMode ? referenceImage : photoModeImage)?.url}
              alt={(isReferenceCompareMode ? referenceImage : photoModeImage)?.label ?? 'Reference'}
              className="w-full h-full object-contain"
              draggable={false}
            />
          </div>
        )}
        {isReferenceCompareMode && (
          <div className="absolute top-0 bottom-0 left-1/2 w-px bg-amber-300/80 shadow-[0_0_12px_rgba(245,158,11,0.65)]" />
        )}
        {showReferenceOverlay && referenceImage && (
          <div
            className="absolute inset-0 overflow-hidden pointer-events-none"
            style={{
              clipPath: referenceBlendMode === 'split' ? 'inset(0 0 0 50%)' : 'none',
              opacity: referenceBlendMode === 'difference' ? 1 : referenceOpacity,
              mixBlendMode:
                referenceBlendMode === 'difference' ? 'difference'
                  : referenceBlendMode === 'edge' ? 'screen'
                    : 'normal',
              maskImage:
                referenceBlendMode === 'checker'
                  ? 'linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%,#000),linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%,#000)'
                  : undefined,
              maskSize: referenceBlendMode === 'checker' ? '48px 48px' : undefined,
              maskPosition: referenceBlendMode === 'checker' ? '0 0,24px 24px' : undefined,
              WebkitMaskImage:
                referenceBlendMode === 'checker'
                  ? 'linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%,#000),linear-gradient(45deg,#000 25%,transparent 25%,transparent 75%,#000 75%,#000)'
                  : undefined,
              WebkitMaskSize: referenceBlendMode === 'checker' ? '48px 48px' : undefined,
              WebkitMaskPosition: referenceBlendMode === 'checker' ? '0 0,24px 24px' : undefined,
            }}
          >
            <img
              src={referenceImage.url}
              alt={referenceImage.label ?? 'Reference overlay'}
              className="w-full h-full object-contain"
              style={{
                filter:
                  referenceBlendMode === 'edge'
                    ? 'grayscale(1) contrast(3) brightness(1.2)'
                    : 'none',
              }}
              draggable={false}
            />
          </div>
        )}
      </div>

      {/* Preview: Original Image (Top-Right, below Avg Lum) */}
      {showChrome && (
      <div className="absolute top-14 right-3 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={previewOriginalRef}
          width={300}
          height={300}
          style={{ display: 'block', imageRendering: 'pixelated' }}
        />
        <div className="text-xs text-amber-400 px-2 py-1 font-mono">Original</div>
      </div>
      )}

      {/* Preview: RGB Separated Output (Right-Center) */}
      {showChrome && (
      <div className="absolute right-3 top-1/2 -translate-y-1/2 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={previewSeparatedRef}
          width={300}
          height={300}
          style={{ display: 'block', imageRendering: 'pixelated' }}
        />
        <div className="text-xs text-amber-400 px-2 py-1 font-mono">Separated</div>
      </div>
      )}

      {/* Preview: Composite thumbnail (Bottom-Right, 2D canvas fed by throttled GPU readback) */}
      {showChrome && (
      <div className="absolute bottom-3 right-3 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={canvasRef}
          width={300}
          height={300}
          style={{ display: 'block', width: '300px', height: '300px', imageRendering: 'pixelated' }}
        />
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs text-amber-400 font-mono">Composite</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setTracerPreviewFrozen(!tracerPreviewFrozen)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                tracerPreviewFrozen
                  ? 'bg-red-600 hover:bg-red-500 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
              }`}
              title={tracerPreviewFrozen ? 'Unfreeze thumbnail' : 'Freeze thumbnail'}
            >
              {tracerPreviewFrozen ? '⏸ Frozen' : 'Live'}
            </button>
            <button
              onClick={() => setLivePreviewEnabled(!livePreviewEnabled)}
              className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                livePreviewEnabled
                  ? 'bg-amber-700 hover:bg-amber-600 text-amber-100'
                  : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
              }`}
              title={livePreviewEnabled ? 'Disable live thumbnail updates' : 'Enable live thumbnail updates'}
            >
              {livePreviewEnabled ? 'Preview On' : 'Preview Off'}
            </button>
          </div>
        </div>
      </div>
      )}

      {/* Image navigation — issue #53: prev/next instead of one-dot-per-image */}
      {showChrome && imageList.length > 1 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 z-40 bg-black/40 backdrop-blur-md rounded px-3 py-1.5 border border-amber-500/20">
          <button
            onClick={() => selectSourceIndex(Math.max(0, currentImageIndex - 1))}
            disabled={currentImageIndex === 0}
            className="text-amber-400 hover:text-amber-200 font-mono text-sm disabled:opacity-30 transition-colors"
          >◀</button>
          <span className="text-amber-300 font-mono text-xs tabular-nums select-none">
            {currentImageIndex + 1} / {imageList.length}
          </span>
          <button
            onClick={() => selectSourceIndex(Math.min(imageList.length - 1, currentImageIndex + 1))}
            disabled={currentImageIndex === imageList.length - 1}
            className="text-amber-400 hover:text-amber-200 font-mono text-sm disabled:opacity-30 transition-colors"
          >▶</button>
          <button
            onClick={() => selectSourceIndex(Math.floor(Math.random() * imageList.length))}
            className="text-amber-400/60 hover:text-amber-300 font-mono text-xs ml-1 transition-colors"
            title="Random image"
          >⚄</button>
        </div>
      )}

      {/* Pause button */}
      {showChrome && (
      <div className="absolute bottom-3 left-3 z-40">
        <button
          onClick={() => setIsPaused(!isPaused)}
          className={`px-3 py-1.5 rounded font-mono text-sm transition-colors ${
            isPaused
              ? 'bg-amber-500 hover:bg-amber-400 text-black'
              : 'bg-gray-800 hover:bg-gray-700 text-amber-400 border border-amber-500/50'
          }`}
        >
          {isPaused ? '▶ Resume' : '⏸ Pause'}
        </button>
      </div>
      )}

      {showChrome && (
      <ImageStrip
        images={imageList}
        currentIndex={currentImageIndex}
        referenceUrl={referenceImage?.url ?? null}
        isOpen={isImageStripOpen}
        onToggleOpen={() => setIsImageStripOpen((prev: boolean) => !prev)}
        onSelectSource={(index) => {
          selectSourceIndex(index);
          setMainViewMode(MAIN_VIEW_MODES.PROCESSED_COMPOSITE);
        }}
        onSelectReference={(index) => {
          setReferenceImage(imageList[index] ?? null);
        }}
        onClearLibrary={handleClearLocalLibrary}
      />
      )}

      {/* Average luminance control */}
      {showChrome && (
      <div className="absolute top-3 right-3 z-40 bg-black/40 backdrop-blur-md rounded p-2 flex flex-col items-end gap-1 border border-amber-500/30">
        <span className="text-xs text-amber-400 font-mono">
          Avg Lum: <span className="tabular-nums text-amber-200">{avgLuminance}</span>
        </span>
        <input
          type="range"
          min={0}
          max={255}
          value={avgLuminance}
          onChange={(e) => setAvgLuminance(Number(e.target.value))}
          className="w-28 h-1 accent-amber-400"
        />
        {/* Active engine indicator */}
        <span className={`text-[10px] font-mono mt-0.5 ${
          engineMode === 'wasm' && wasmAvailable
            ? 'text-cyan-400'
            : 'text-amber-500/60'
        }`}>
          {engineMode === 'wasm' && wasmAvailable ? '⚡ C++ WASM' : '🔷 TS'}
        </span>
        <span className="text-[10px] font-mono text-emerald-300/80">
          CPU {renderCpuTiming.last.toFixed(2)} / {renderCpuTiming.avg.toFixed(2)} ms
        </span>
        {!performanceHudEnabled && (
          <span className="text-[10px] font-mono text-cyan-300/80">
            2+ {collisionStats.twoOverlapPixels} | 3 {collisionStats.threeOverlapPixels}
          </span>
        )}
        {!performanceHudEnabled && (
          <span className="text-[10px] font-mono text-cyan-200/70">
            Win {collisionStats.dominantLayerWins[0]}/{collisionStats.dominantLayerWins[1]}/{collisionStats.dominantLayerWins[2]}
          </span>
        )}
      </div>
      )}

      {/* GPU error / device loss notice */}
      {gpuError && (
        <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/80 backdrop-blur-sm">
          <div className="bg-gray-900/90 backdrop-blur-md border border-red-500/50 rounded-lg p-6 max-w-md text-center shadow-2xl shadow-red-900/20">
            <p className="text-red-400 font-mono text-sm">{gpuError.message}</p>
            {gpuError.detail && (
              <p className="text-red-300/80 font-mono text-xs mt-2 break-words">{gpuError.detail}</p>
            )}
            <p className="text-amber-200/70 text-xs mt-3">
              {gpuError.kind === 'device-lost'
                ? 'The GPU process may have restarted. Reload the page or switch to the WebGL2 fallback.'
                : 'Use Chrome/Edge with WebGPU, or open with ?renderer=webgl for the WebGL2 fallback.'}
            </p>
            {gpuError.recoverable && (
              <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
                <button
                  type="button"
                  className="px-3 py-1.5 rounded bg-amber-500/20 border border-amber-400/40 text-amber-100 text-xs font-mono hover:bg-amber-500/30"
                  onClick={() => window.location.reload()}
                >
                  Reload page
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 rounded bg-cyan-500/20 border border-cyan-400/40 text-cyan-100 text-xs font-mono hover:bg-cyan-500/30"
                  onClick={() => switchRendererPreference('webgl')}
                >
                  Switch to WebGL2
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* NUNIF control overlay */}
      {showChrome && (
      <NunifOverlay
        layerAngles={layerAngles}
        layerExtensions={layerExtensions}
        frameRate={frameRate}
        layerOpacity={layerOpacity}
        layerOpacities={layerOpacities}
        layerScale={layerScale}
        tracerScale={tracerScale}
        tracerAboveIntensity={tracerAboveIntensity}
        tracerBelowIntensity={tracerBelowIntensity}
        tracerAboveDuration={tracerAboveDuration}
        tracerBelowDuration={tracerBelowDuration}
        tracerMode={tracerMode}
        layerBlendMode={layerBlendMode}
        tracerBlendMode={tracerBlendMode}
        outputMode={outputMode}
        diagnosticsMode={diagnosticsMode}
        diagnosticsOpacity={diagnosticsOpacity}
        stampBoost={stampBoost}
        peakCollisionsOnly={peakCollisionsOnly}
        collisionStats={collisionStats}
        rendererBackend={rendererBackend}
        rendererFallbackReason={rendererFallbackReason}
        webglDebugMode={webglDebugMode}
        onRendererBackendChange={switchRendererPreference}
        onWebglDebugModeChange={setWebglDebugMode}
        mainViewMode={mainViewMode}
        isViewingTracer={isViewingTracer}
        isPaused={isPaused}
        tracerInspectHeatmap={tracerInspectHeatmap}
        tracerInspectZoom={tracerInspectZoom}
        tracerInspectExposure={tracerInspectExposure}
        tracerInspectTonemap={tracerInspectTonemap}
        tracerInspectShowLayers={tracerInspectShowLayers}
        exportingTracer={exportingTracer}
        currentImageLabel={currentImage?.label ?? currentImage?.url ?? null}
        referenceImageLabel={referenceImage?.label ?? referenceImage?.url ?? null}
        isImageStripOpen={isImageStripOpen}
        referenceBlendMode={referenceBlendMode}
        referenceOpacity={referenceOpacity}
        onTracerViewToggle={(next) => setMainViewMode(
          next ? MAIN_VIEW_MODES.FULL_RES_TRACER : MAIN_VIEW_MODES.PROCESSED_COMPOSITE,
        )}
        onMainViewModeChange={setMainViewMode}
        onEngineModeChange={(mode: 'ts' | 'wasm') => {
          if (mode === 'wasm' && !isWasmReady()) return;
          setEngineMode(mode);
        }}
        onToggleImageStrip={() => setIsImageStripOpen((prev: boolean) => !prev)}
        onSwapSourceReference={swapSourceAndReference}
        onReferenceBlendModeChange={setReferenceBlendMode}
        onReferenceOpacityChange={setReferenceOpacity}
        onFreezeInspect={handleFreezeInspect}
        onTracerInspectHeatmapToggle={setTracerInspectHeatmap}
        onTracerInspectZoomChange={setTracerInspectZoom}
        onTracerInspectExposureChange={setTracerInspectExposure}
        onTracerInspectTonemapToggle={setTracerInspectTonemap}
        onTracerInspectShowLayersToggle={setTracerInspectShowLayers}
        onResetInspectView={handleResetInspectView}
        onExportTracer={handleExportTracer}
        exportingVideo={exportingVideo}
        videoExportProgress={videoExportProgress}
        videoExportSettings={videoExportSettings}
        codecSupport={codecSupport}
        onExportVideo={handleExportVideo}
        onCancelVideoExport={handleCancelVideoExport}
        onVideoExportDurationChange={onVideoExportDurationChange}
        onVideoExportFpsChange={onVideoExportFpsChange}
        onVideoExportScaleChange={onVideoExportScaleChange}
        onVideoExportIncludeTracersChange={onVideoExportIncludeTracersChange}
        onVideoExportPassModeChange={onVideoExportPassModeChange}
        onVideoExportFilenameChange={onVideoExportFilenameChange}
        onVideoExportUsePresetAnglesChange={onVideoExportUsePresetAnglesChange}
        squareCanvas={squareCanvas}
        antialiasEnabled={antialiasEnabled}
        viewportQuarterZoom={viewportQuarterZoom}
        viewportHalfOverlay={viewportHalfOverlay}
        onAngleChange={handleAngleChange}
        onExtensionChange={handleExtensionChange}
        onFrameRateChange={setFrameRate}
        onLayerOpacityChange={setLayerOpacity}
        onLayerOpacityPerLayerChange={(layer, opacity) => {
          setLayerOpacities((prev: [number, number, number]) => {
            const next = [...prev] as [number, number, number];
            next[layer] = opacity;
            return next;
          });
        }}
        onLayerScaleChange={setLayerScale}
        onTracerScaleChange={setTracerScale}
        onTracerAboveIntensityChange={setTracerAboveIntensity}
        onTracerBelowIntensityChange={setTracerBelowIntensity}
        onTracerAboveDurationChange={setTracerAboveDuration}
        onTracerBelowDurationChange={setTracerBelowDuration}
        onTracerModeChange={setTracerMode}
        onLayerBlendModeChange={setLayerBlendMode}
        onTracerBlendModeChange={setTracerBlendMode}
        onOutputModeChange={setOutputMode}
        onDiagnosticsModeChange={setDiagnosticsMode}
        onDiagnosticsOpacityChange={setDiagnosticsOpacity}
        onStampBoostChange={setStampBoost}
        onPeakCollisionsOnlyChange={setPeakCollisionsOnly}
        performanceHudEnabled={performanceHudEnabled}
        performanceAutoDegrade={performanceAutoDegrade}
        performanceBudgetExceeded={performanceBudgetExceeded}
        renderCpuTiming={renderCpuTiming}
        renderGpuTiming={renderGpuTiming}
        frameTimeHistory={frameTimeHistory}
        onPerformanceHudToggle={setPerformanceHudEnabled}
        onPerformanceAutoDegradeToggle={setPerformanceAutoDegrade}
        onApplyPerformanceDegrade={() => {
          rendererRef.current?.setAntialiasing(false);
          applyPerformanceDegrade();
        }}
        colorMode={colorMode}
        onColorModeChange={setColorMode}
        sobelEnabled={sobelEnabled}
        onSobelEnabledToggle={setSobelEnabled}
        softCropEnabled={softCropEnabled}
        onSoftCropEnabledToggle={setSoftCropEnabled}
        onSquareCanvasToggle={setSquareCanvas}
        onAntialiasToggle={(enabled) => {
          setAntialiasEnabled(enabled);
          rendererRef.current?.setAntialiasing(enabled);
        }}
        onViewportQuarterZoomToggle={(enabled) => {
          setViewportQuarterZoom(enabled);
          if (enabled) setViewportHalfOverlay(false);
        }}
        onViewportHalfOverlayToggle={(enabled) => {
          setViewportHalfOverlay(enabled);
          if (enabled) setViewportQuarterZoom(false);
        }}
        onReset={handleReset}
        builtinPresets={builtinPresets}
        savedPresets={savedPresets}
        presetStatus={presetStatus}
        presetError={presetError}
        onSavePreset={handleSavePreset}
        onLoadPreset={handleLoadPreset}
        onDeletePreset={handleDeletePreset}
        onApplyBuiltinPreset={handleApplyBuiltinPreset}
        onCopyPresetUrl={handleCopyPresetUrl}
        onExportPresetFile={handleExportPresetFile}
        onImportPresetFile={handleImportPresetFile}
        isAutoPlayActive={isAutoPlayActive}
        onAutoPlayToggle={setIsAutoPlayActive}
        imageChangeInterval={imageChangeInterval}
        onImageChangeIntervalChange={setImageChangeInterval}
        onLoadSpecificImage={handleLoadSpecificImage}
        onLoadFile={handleLoadFile}
        onLoadReferenceImage={handleLoadReferenceImage}
        onLoadReferenceFile={handleLoadReferenceFile}
        upscaleModel={upscaleModel}
        onUpscaleModelChange={setUpscaleModel}
        upscaleBusy={upscaleBusy}
        upscaleProgress={upscaleProgress}
        upscaleInfo={upscaleInfo}
        onUpscaleSource={handleUpscaleSource}
        onUpscaleOutput={handleUpscaleOutput}
        engineMode={engineMode}
        wasmAvailable={wasmAvailable}
        reactiveEnabled={reactiveEnabled}
        audioEnabled={audioEnabled}
        midiEnabled={midiEnabled}
        micActive={micActive}
        micError={micError}
        midiAvailable={midiAvailable}
        midiError={midiError}
        midiLearnTarget={midiLearnTarget}
        midiBindings={midiBindings}
        audioLevels={audioLevels}
        audioSensitivity={audioSensitivity}
        layerExtension0={layerExtension0}
        onReactiveEnabledChange={onReactiveEnabledChange}
        onAudioEnabledChange={onAudioEnabledChange}
        onMidiEnabledChange={onMidiEnabledChange}
        onAudioSensitivityChange={onAudioSensitivityChange}
        onStartMicDemo={onStartMicDemo}
        onMidiLearnTargetChange={onMidiLearnTargetChange}
        onRemoveMidiBinding={onRemoveMidiBinding}
      />
      )}

      {showKioskRemote && (
        <KioskRemote
          currentIndex={currentImageIndex}
          imageCount={imageList.length}
          onPrevious={() => selectSourceIndex(Math.max(0, currentImageIndex - 1))}
          onNext={() => selectSourceIndex(Math.min(imageList.length - 1, currentImageIndex + 1))}
          onRandom={() => {
            if (imageList.length > 0) {
              selectSourceIndex(Math.floor(Math.random() * imageList.length));
            }
          }}
          onToggleFullscreen={() => { void toggleKioskFullscreen(); }}
          isFullscreen={kioskFullscreen}
        />
      )}

      {showKioskRemote && !kioskFullscreen && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 pointer-events-none text-amber-200/50 font-mono text-xs bg-black/30 px-3 py-1 rounded-full border border-amber-500/20">
          Click canvas or press F for fullscreen · ? for shortcuts · Esc restores panels
        </div>
      )}

      {shortcutsOverlayVisible && (
        <ShortcutsOverlay
          kioskEnabled={kioskEnabled}
          kioskUiHidden={kioskUiHidden}
          onClose={() => setShortcutsOverlayVisible(false)}
        />
      )}

      {/* Specific image error toast */}
      {specificImageError && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-50 bg-red-900/90 border border-red-500/50 rounded px-4 py-2 text-red-200 text-sm font-mono shadow-lg">
          {specificImageError}
          <button onClick={() => setSpecificImageError(null)} className="ml-3 text-red-400 hover:text-white">×</button>
        </div>
      )}
    </div>
  );
}
