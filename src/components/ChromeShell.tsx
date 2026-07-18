import { ImageStrip } from './ImageStrip';
import { KioskRemote } from './KioskRemote';
import { ShortcutsOverlay } from './ShortcutsOverlay';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import { switchRendererPreference } from '../engine/rendererMode';
import type { ChromeShellProps } from './AppUI.types';

export function ChromeShell({
  showChrome,
  showKioskRemote,
  gpuError,
  collisionStats,
  avgLuminance,
  engineMode,
  wasmAvailable,
  renderCpuTiming,
  performanceHudEnabled,
  imageList,
  currentImageIndex,
  referenceImage,
  isImageStripOpen,
  isPaused,
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
}: ChromeShellProps) {
  return (
    <>
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
          onToggleOpen={toggleImageStrip}
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

      {specificImageError && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-50 bg-red-900/90 border border-red-500/50 rounded px-4 py-2 text-red-200 text-sm font-mono shadow-lg">
          {specificImageError}
          <button onClick={() => setSpecificImageError(null)} className="ml-3 text-red-400 hover:text-white">×</button>
        </div>
      )}
    </>
  );
}
