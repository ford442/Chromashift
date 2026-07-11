import { useRef, useState } from 'react';
import type { BuiltinPreset } from '../../state/presetGallery';
import type { StoredPreset } from '../../state/presetLibrary';

export interface PresetsPanelProps {
  builtinPresets: readonly BuiltinPreset[];
  savedPresets: StoredPreset[];
  presetStatus: string | null;
  presetError: string | null;
  onSavePreset: (name: string) => void;
  onLoadPreset: (name: string) => void;
  onDeletePreset: (name: string) => void;
  onApplyBuiltinPreset: (id: string) => void;
  onCopyPresetUrl: () => void;
  onExportPresetFile: () => void;
  onImportPresetFile: (file: File) => void;
}

export function PresetsPanel({
  builtinPresets,
  savedPresets,
  presetStatus,
  presetError,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
  onApplyBuiltinPreset,
  onCopyPresetUrl,
  onExportPresetFile,
  onImportPresetFile,
}: PresetsPanelProps) {
  const [name, setName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-3">
      <div className="panel-3d space-y-2">
        <span className="text-xs text-amber-300 font-mono text-[10px] uppercase tracking-wider">
          Gallery
        </span>
        <div className="grid grid-cols-2 gap-1">
          {builtinPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.description}
              onClick={() => onApplyBuiltinPreset(preset.id)}
              className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-100 text-left"
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-3d space-y-2">
        <span className="text-xs text-amber-300 font-mono text-[10px] uppercase tracking-wider">
          My Presets
        </span>
        <div className="flex gap-1">
          <input
            type="text"
            value={name}
            placeholder="Preset name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                onSavePreset(name);
                setName('');
              }
            }}
            className="flex-1 text-[10px] bg-zinc-900 border border-amber-500/30 rounded px-1.5 py-1 text-amber-100"
          />
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() => {
              onSavePreset(name);
              setName('');
            }}
            className="text-[10px] px-2 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white disabled:opacity-50 border border-amber-500/40"
          >
            Save
          </button>
        </div>

        {savedPresets.length === 0 && (
          <div className="text-[9px] font-mono text-amber-300/50">No saved presets yet.</div>
        )}
        {savedPresets.map((preset) => (
          <div key={preset.name} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onLoadPreset(preset.name)}
              className="flex-1 text-[10px] px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-100 text-left truncate"
              title={new Date(preset.savedAt).toLocaleString()}
            >
              {preset.name}
            </button>
            <button
              type="button"
              onClick={() => onDeletePreset(preset.name)}
              className="text-[10px] px-1.5 py-1 rounded bg-zinc-800 border border-rose-500/30 hover:bg-zinc-700 text-rose-200"
              title={`Delete “${preset.name}”`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="panel-3d space-y-2">
        <span className="text-xs text-amber-300 font-mono text-[10px] uppercase tracking-wider">
          Share
        </span>
        <div className="grid grid-cols-3 gap-1">
          <button
            type="button"
            onClick={onCopyPresetUrl}
            className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-100"
          >
            Copy URL
          </button>
          <button
            type="button"
            onClick={onExportPresetFile}
            className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-100"
          >
            Export
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-[10px] px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-100"
          >
            Import
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImportPresetFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {presetStatus && !presetError && (
        <div className="text-[9px] font-mono text-emerald-300/80">{presetStatus}</div>
      )}
      {presetError && (
        <div className="text-[9px] text-rose-300/90 font-mono bg-rose-900/20 border border-rose-500/20 rounded px-1.5 py-1">
          {presetError}
        </div>
      )}
    </div>
  );
}
