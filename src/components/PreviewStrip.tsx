import type { PreviewStripProps } from './AppUI.types';

export function PreviewStrip({
  previewOriginalRef,
  previewSeparatedRef,
  previewTracerRef,
  tracerPreviewFrozen,
  setTracerPreviewFrozen,
  livePreviewEnabled,
  setLivePreviewEnabled,
}: PreviewStripProps) {
  return (
    <>
      <div className="absolute top-14 right-3 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={previewOriginalRef}
          width={300}
          height={300}
          style={{ display: 'block', imageRendering: 'pixelated' }}
        />
        <div className="text-xs text-amber-400 px-2 py-1 font-mono">Original</div>
      </div>

      <div className="absolute right-3 top-1/2 -translate-y-1/2 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={previewSeparatedRef}
          width={300}
          height={300}
          style={{ display: 'block', imageRendering: 'pixelated' }}
        />
        <div className="text-xs text-amber-400 px-2 py-1 font-mono">Separated</div>
      </div>

      <div className="absolute bottom-3 right-3 z-30 border border-amber-500/30 rounded overflow-hidden bg-black/40 backdrop-blur-md">
        <canvas
          ref={previewTracerRef}
          width={300}
          height={300}
          style={{ display: 'block', width: '300px', height: '300px', imageRendering: 'pixelated' }}
        />
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs text-amber-400 font-mono">Tracer</span>
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
              title={livePreviewEnabled ? 'Disable tracer thumbnail refresh' : 'Enable tracer thumbnail refresh'}
            >
              {livePreviewEnabled ? 'Preview On' : 'Preview Off'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
