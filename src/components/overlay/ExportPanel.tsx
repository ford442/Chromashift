import type { ExportPassMode } from '../../engine/types/RendererContracts';
import type { VideoCodecSupport } from '../../engine/videoExport/videoCodecs';
import type { VideoExportSettings } from '../../state/types';

export interface ExportPanelProps {
  exportingVideo: boolean;
  videoExportProgress: number;
  videoExportSettings: VideoExportSettings;
  codecSupport: VideoCodecSupport;
  onExportVideo: () => void;
  onCancelVideoExport: () => void;
  onVideoExportDurationChange: (seconds: number) => void;
  onVideoExportFpsChange: (fps: number) => void;
  onVideoExportScaleChange: (scale: number) => void;
  onVideoExportIncludeTracersChange: (include: boolean) => void;
  onVideoExportPassModeChange: (mode: ExportPassMode) => void;
  onVideoExportFilenameChange: (filename: string) => void;
  onVideoExportUsePresetAnglesChange: (usePreset: boolean) => void;
}

const PASS_MODE_LABELS: Record<ExportPassMode, string> = {
  composite: 'Composite',
  tracers: 'Tracers only',
  layers: 'Layers only',
};

export function ExportPanel({
  exportingVideo,
  videoExportProgress,
  videoExportSettings,
  codecSupport,
  onExportVideo,
  onCancelVideoExport,
  onVideoExportDurationChange,
  onVideoExportFpsChange,
  onVideoExportScaleChange,
  onVideoExportIncludeTracersChange,
  onVideoExportPassModeChange,
  onVideoExportFilenameChange,
  onVideoExportUsePresetAnglesChange,
}: ExportPanelProps) {
  const progressPct = Math.round(videoExportProgress * 100);
  const canExport = codecSupport.mediaRecorder && !exportingVideo;

  return (
    <div className="space-y-3">
      <div className="panel-3d space-y-2">
        <span className="text-xs text-emerald-300 font-mono text-[10px] uppercase tracking-wider">
          Video Export
        </span>

        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-emerald-200/70 font-mono">
            Duration (s)
            <input
              type="number"
              min={1}
              max={60}
              step={0.5}
              value={videoExportSettings.durationSec}
              disabled={exportingVideo}
              onChange={(e) => onVideoExportDurationChange(Number(e.target.value))}
              className="mt-0.5 w-full text-[10px] bg-zinc-900 border border-emerald-500/30 rounded px-1.5 py-1 text-emerald-100"
            />
          </label>
          <label className="text-[10px] text-emerald-200/70 font-mono">
            FPS
            <input
              type="number"
              min={1}
              max={60}
              step={1}
              value={videoExportSettings.fps}
              disabled={exportingVideo}
              onChange={(e) => onVideoExportFpsChange(Number(e.target.value))}
              className="mt-0.5 w-full text-[10px] bg-zinc-900 border border-emerald-500/30 rounded px-1.5 py-1 text-emerald-100"
            />
          </label>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-emerald-200/70 font-mono whitespace-nowrap">
            Scale: <span className="tabular-nums text-emerald-100">{videoExportSettings.resolutionScale.toFixed(2)}x</span>
          </span>
          <input
            type="range"
            min={0.25}
            max={2}
            step={0.05}
            value={videoExportSettings.resolutionScale}
            disabled={exportingVideo}
            onChange={(e) => onVideoExportScaleChange(Number(e.target.value))}
            className="flex-1 h-1 accent-emerald-400"
          />
        </div>

        <label className="text-[10px] text-emerald-200/70 font-mono block">
          Filename
          <input
            type="text"
            value={videoExportSettings.filename}
            disabled={exportingVideo}
            onChange={(e) => onVideoExportFilenameChange(e.target.value)}
            className="mt-0.5 w-full text-[10px] bg-zinc-900 border border-emerald-500/30 rounded px-1.5 py-1 text-emerald-100"
          />
        </label>

        <label className="text-[10px] text-emerald-200/70 font-mono block">
          Pass
          <select
            value={videoExportSettings.passMode}
            disabled={exportingVideo}
            onChange={(e) => onVideoExportPassModeChange(e.target.value as ExportPassMode)}
            className="mt-0.5 w-full text-[10px] bg-zinc-900 border border-emerald-500/30 rounded px-1.5 py-1 text-emerald-100"
          >
            {(Object.keys(PASS_MODE_LABELS) as ExportPassMode[]).map((mode) => (
              <option key={mode} value={mode}>{PASS_MODE_LABELS[mode]}</option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            disabled={exportingVideo}
            onClick={() => onVideoExportIncludeTracersChange(!videoExportSettings.includeTracers)}
            className={`text-[10px] px-2 py-1 rounded transition-all ${
              videoExportSettings.includeTracers
                ? 'bg-emerald-600 text-white shadow-[0_0_8px_rgba(16,185,129,0.4)]'
                : 'bg-zinc-800 border border-emerald-500/30 hover:bg-zinc-700 text-emerald-200'
            }`}
          >
            {videoExportSettings.includeTracers ? 'Tracers On' : 'Tracers Off'}
          </button>
          <button
            type="button"
            disabled={exportingVideo}
            onClick={() => onVideoExportUsePresetAnglesChange(!videoExportSettings.usePresetAngles)}
            className={`text-[10px] px-2 py-1 rounded transition-all ${
              videoExportSettings.usePresetAngles
                ? 'bg-cyan-600 text-white shadow-[0_0_8px_rgba(6,182,212,0.4)]'
                : 'bg-zinc-800 border border-cyan-500/30 hover:bg-zinc-700 text-cyan-200'
            }`}
            title="Use panel angle knobs as frame 0 instead of the live animation position"
          >
            {videoExportSettings.usePresetAngles ? 'Preset Angles' : 'Live Angles'}
          </button>
        </div>

        {exportingVideo && (
          <div className="space-y-1">
            <div className="h-1.5 bg-zinc-800 rounded overflow-hidden border border-emerald-500/20">
              <div
                className="h-full bg-emerald-500 transition-all duration-150"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="text-[10px] font-mono text-emerald-200/80 tabular-nums">
              Rendering… {progressPct}%
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={onExportVideo}
            disabled={!canExport}
            className="text-[10px] px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50 border border-emerald-500/40"
          >
            {exportingVideo ? 'Exporting…' : 'Export Video'}
          </button>
          <button
            type="button"
            onClick={onCancelVideoExport}
            disabled={!exportingVideo}
            className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-rose-500/30 hover:bg-zinc-700 text-rose-200 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>

        <div className="text-[9px] font-mono text-emerald-300/60 leading-tight">
          Codec: {codecSupport.preferredMimeType ?? 'unsupported'}
          {codecSupport.webCodecs ? ' · WebCodecs available' : ''}
        </div>
        {!codecSupport.mediaRecorder && (
          <div className="text-[9px] text-rose-300/90 font-mono bg-rose-900/20 border border-rose-500/20 rounded px-1.5 py-1">
            MediaRecorder is not available in this browser. See docs/VIDEO_EXPORT.md.
          </div>
        )}
      </div>
    </div>
  );
}
