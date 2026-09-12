import { memo, useRef } from 'react';
import type { ImageEntry } from '../engine/TextureManager';
import type { LiveSourceState } from '../state/types';
import { useRenderCount } from '../debug/renderCounts';
import { CorpusBrowser } from './CorpusBrowser';

interface Props {
  images: ImageEntry[];
  /** Pre-derived by the reducer — never recount `images` here (it holds thousands). */
  localCount: number;
  currentIndex: number;
  referenceUrl: string | null;
  isOpen: boolean;
  onToggleOpen: () => void;
  onSelectSource: (index: number) => void;
  onSelectReference: (index: number) => void;
  onClearLibrary: () => void;
  liveSource: LiveSourceState;
  onStartCamera: () => void;
  onStartScreenShare: () => void;
  onLoadVideoFile: (file: File) => void;
  onStopLiveSource: () => void;
}

function liveSourceLabel(kind: LiveSourceState['kind']): string {
  if (kind === 'camera') return 'Camera';
  if (kind === 'screen') return 'Screen Share';
  if (kind === 'video-file') return 'Video File';
  return 'Live';
}

/**
 * The bottom toolbar (browser toggle + live-source controls), plus the corpus
 * panel when it is open.
 *
 * The panel itself lives in `CorpusBrowser` so that a closed strip mounts none
 * of its machinery, and so this component keeps rendering exactly as often as
 * its own props change — `e2e/render-churn.spec.ts` asserts that is never,
 * while the app merely runs.
 */
export const ImageStrip = memo(function ImageStrip({
  images,
  localCount,
  currentIndex,
  referenceUrl,
  isOpen,
  onToggleOpen,
  onSelectSource,
  onSelectReference,
  onClearLibrary,
  liveSource,
  onStartCamera,
  onStartScreenShare,
  onLoadVideoFile,
  onStopLiveSource,
}: Props) {
  useRenderCount('ImageStrip');
  const videoFileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="absolute inset-x-0 bottom-0 z-40 pointer-events-none">
      <div className="flex justify-center items-center gap-2 mb-2 pointer-events-auto">
        <button
          onClick={onToggleOpen}
          data-testid="corpus-browser-toggle"
          className="px-3 py-1 rounded-full bg-black/65 backdrop-blur-md border border-amber-500/30 text-amber-200 text-xs font-mono hover:bg-black/80 transition-colors"
        >
          {isOpen ? 'Hide Browser' : 'Browse Images'}
        </button>

        {liveSource.active ? (
          <button
            onClick={onStopLiveSource}
            className="px-3 py-1 rounded-full bg-red-900/70 backdrop-blur-md border border-red-500/40 text-red-200 text-xs font-mono hover:bg-red-800/80 transition-colors"
            title={`${liveSourceLabel(liveSource.kind)}${liveSource.width ? ` — ${liveSource.width}×${liveSource.height}` : ''}`}
          >
            ⏹ Stop {liveSourceLabel(liveSource.kind)}
          </button>
        ) : (
          <>
            <button
              onClick={onStartCamera}
              className="px-3 py-1 rounded-full bg-black/65 backdrop-blur-md border border-emerald-500/30 text-emerald-200 text-xs font-mono hover:bg-black/80 transition-colors"
              title="Drive the composite from a live webcam feed"
            >
              📷 Camera
            </button>
            <button
              onClick={onStartScreenShare}
              className="px-3 py-1 rounded-full bg-black/65 backdrop-blur-md border border-emerald-500/30 text-emerald-200 text-xs font-mono hover:bg-black/80 transition-colors"
              title="Drive the composite from a shared screen/window"
            >
              🖥️ Screen
            </button>
            <button
              onClick={() => videoFileInputRef.current?.click()}
              className="px-3 py-1 rounded-full bg-black/65 backdrop-blur-md border border-emerald-500/30 text-emerald-200 text-xs font-mono hover:bg-black/80 transition-colors"
              title="Loop a local video file as the composite source"
            >
              🎬 Video File
            </button>
            <input
              ref={videoFileInputRef}
              type="file"
              accept="video/*"
              data-testid="live-source-video-file-input"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onLoadVideoFile(file);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>

      {liveSource.error && (
        <div className="flex justify-center mb-2 pointer-events-auto">
          <div className="px-3 py-1 rounded-full bg-red-900/80 backdrop-blur-md border border-red-500/40 text-red-200 text-[11px] font-mono">
            {liveSource.error}
          </div>
        </div>
      )}

      {isOpen && (
        <CorpusBrowser
          images={images}
          localCount={localCount}
          currentIndex={currentIndex}
          referenceUrl={referenceUrl}
          onSelectSource={onSelectSource}
          onSelectReference={onSelectReference}
          onClearLibrary={onClearLibrary}
        />
      )}
    </div>
  );
});
