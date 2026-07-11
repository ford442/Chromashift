interface KioskRemoteProps {
  currentIndex: number;
  imageCount: number;
  onPrevious: () => void;
  onNext: () => void;
  onRandom: () => void;
  onToggleFullscreen: () => void;
  isFullscreen: boolean;
}

export function KioskRemote({
  currentIndex,
  imageCount,
  onPrevious,
  onNext,
  onRandom,
  onToggleFullscreen,
  isFullscreen,
}: KioskRemoteProps) {
  if (imageCount <= 1) {
    return (
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex gap-4" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onToggleFullscreen}
          className="kiosk-remote-btn min-w-[5rem] px-6 py-4 rounded-2xl bg-black/55 border-2 border-amber-400/50 text-amber-100 font-mono text-lg backdrop-blur-md hover:bg-amber-500/20 transition-colors"
        >
          {isFullscreen ? 'Exit FS' : 'Fullscreen'}
        </button>
      </div>
    );
  }

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 bg-black/50 backdrop-blur-md border-2 border-amber-400/40 rounded-2xl px-5 py-3"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onPrevious}
        disabled={currentIndex === 0}
        className="kiosk-remote-btn min-w-[4.5rem] px-5 py-4 rounded-xl bg-zinc-900/80 border border-amber-500/40 text-amber-200 font-mono text-2xl disabled:opacity-30 hover:bg-amber-500/15 transition-colors"
        aria-label="Previous image"
      >
        ◀
      </button>
      <div className="text-center min-w-[6rem] select-none">
        <div className="text-amber-200 font-mono text-xl tabular-nums">
          {currentIndex + 1} / {imageCount}
        </div>
        <button
          type="button"
          onClick={onRandom}
          className="mt-1 text-amber-400/80 hover:text-amber-200 font-mono text-sm px-3 py-1 rounded-lg border border-amber-500/30"
        >
          Random
        </button>
      </div>
      <button
        type="button"
        onClick={onNext}
        disabled={currentIndex >= imageCount - 1}
        className="kiosk-remote-btn min-w-[4.5rem] px-5 py-4 rounded-xl bg-zinc-900/80 border border-amber-500/40 text-amber-200 font-mono text-2xl disabled:opacity-30 hover:bg-amber-500/15 transition-colors"
        aria-label="Next image"
      >
        ▶
      </button>
      <button
        type="button"
        onClick={onToggleFullscreen}
        className="kiosk-remote-btn min-w-[4.5rem] px-4 py-4 rounded-xl bg-zinc-900/80 border border-amber-500/40 text-amber-200 font-mono text-sm hover:bg-amber-500/15 transition-colors"
      >
        {isFullscreen ? 'Exit FS' : 'Full'}
      </button>
    </div>
  );
}
