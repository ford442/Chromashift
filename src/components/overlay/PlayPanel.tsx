import { useRef } from 'react';
import type { PlayPanelProps } from './types';

export function PlayPanel({
  imageChangeInterval,
  onImageChangeIntervalChange,
  isImageStripOpen,
  onToggleImageStrip,
  onLoadSpecificImage,
  onLoadFile,
  referenceImageLabel,
  onLoadReferenceImage,
  onLoadReferenceFile,
}: PlayPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceFileInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <div className="panel-3d">
        <div className="flex items-center gap-2">
          <label className="text-xs text-amber-400/80 font-mono whitespace-nowrap">
            Image: <span className="tabular-nums text-amber-300">{imageChangeInterval}s</span>
          </label>
          <input
            type="range"
            min={2}
            max={30}
            value={imageChangeInterval}
            onChange={(e) => onImageChangeIntervalChange(Number(e.target.value))}
            className="flex-1 h-1 accent-amber-400"
          />
        </div>
      </div>

      <div className="panel-3d space-y-2">
        <div className="text-[10px] text-amber-300 font-mono uppercase tracking-wider">📷 Load</div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              const url = prompt('Enter image URL:', '');
              if (url && url.trim()) onLoadSpecificImage(url.trim());
            }}
            className="flex-1 text-xs px-2 py-1 rounded bg-purple-700/80 hover:bg-purple-600 text-white transition-all hover:shadow-[0_0_12px_rgba(168,85,247,0.4)]"
          >
            URL
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 transition-all"
          >
            File
          </button>
        </div>
        <button
          type="button"
          onClick={onToggleImageStrip}
          className={`w-full text-xs px-2 py-1 rounded transition-all ${
            isImageStripOpen
              ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_12px_rgba(245,158,11,0.35)]'
              : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-amber-200'
          }`}
        >
          {isImageStripOpen ? 'Hide Browser' : 'Browse Images'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onLoadFile(file);
            e.target.value = '';
          }}
        />
      </div>

      <div className="panel-3d space-y-2">
        <div className="text-[10px] text-cyan-300 font-mono uppercase tracking-wider">🖼 Reference</div>
        <div className="text-[10px] text-cyan-200/70 font-mono min-h-[1rem]">
          {referenceImageLabel ?? 'No reference loaded'}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              const url = prompt('Enter reference image URL:', '');
              if (url && url.trim()) onLoadReferenceImage(url.trim());
            }}
            className="flex-1 text-xs px-2 py-1 rounded bg-cyan-700/80 hover:bg-cyan-600 text-white transition-all"
          >
            Ref URL
          </button>
          <button
            type="button"
            onClick={() => referenceFileInputRef.current?.click()}
            className="flex-1 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-cyan-500/30 transition-all text-cyan-100"
          >
            Ref File
          </button>
        </div>
        <input
          ref={referenceFileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onLoadReferenceFile(file);
            e.target.value = '';
          }}
        />
      </div>
    </>
  );
}
