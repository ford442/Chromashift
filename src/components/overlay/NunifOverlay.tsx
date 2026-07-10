import { CollapsibleSection } from './CollapsibleSection';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ExportPanel } from './ExportPanel';
import { LayerPanel } from './LayerPanel';
import { PlayPanel } from './PlayPanel';
import { RendererPanel } from './RendererPanel';
import { TracerPanel } from './TracerPanel';
import { UpscalePanel } from './UpscalePanel';
import { ViewportPanel } from './ViewportPanel';
import type { OverlayProps } from './types';
import { useOverlaySections } from './useOverlaySections';

export function NunifOverlay(props: OverlayProps) {
  const { sections, toggleSection } = useOverlaySections();

  return (
    <div className="fixed left-0 top-1/2 -translate-y-1/2 z-50 w-96 bg-zinc-950/95 backdrop-blur-xl border-r border-amber-500/20 text-white p-4 select-none overflow-y-auto max-h-[95vh] rounded-r-xl shadow-[0_0_60px_rgba(0,0,0,0.8),0_0_30px_rgba(245,158,11,0.15)] space-y-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono font-bold tracking-widest text-amber-300 uppercase drop-shadow-[0_0_6px_rgba(251,191,36,0.6)]">
          ✨ NUNIF Controls
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => props.onAutoPlayToggle(!props.isAutoPlayActive)}
            className={`text-xs px-2 py-0.5 rounded transition-all ${
              props.isAutoPlayActive
                ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_12px_rgba(245,158,11,0.5)] scale-105'
                : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30'
            }`}
          >
            {props.isAutoPlayActive ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            onClick={props.onReset}
            className="text-xs px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 transition-all hover:shadow-[0_0_12px_rgba(245,158,11,0.3)]"
          >
            ⟲
          </button>
        </div>
      </div>

      <PlayPanel {...props} />

      <CollapsibleSection
        id="renderer"
        title="🎛 Renderer & Engine"
        open={sections.renderer}
        onToggle={toggleSection}
      >
        <RendererPanel {...props} />
      </CollapsibleSection>

      <CollapsibleSection
        id="layers"
        title="🌍 Layers & Global"
        open={sections.layers}
        onToggle={toggleSection}
      >
        <LayerPanel {...props} />
      </CollapsibleSection>

      <CollapsibleSection
        id="tracer"
        title="✨ Dual Tracer"
        open={sections.tracer}
        onToggle={toggleSection}
      >
        <TracerPanel {...props} />
      </CollapsibleSection>

      <CollapsibleSection
        id="upscale"
        title="🔍 Upscale"
        open={sections.upscale}
        onToggle={toggleSection}
        hint="Real-ESRGAN / waifu2x research tools"
      >
        <UpscalePanel {...props} />
      </CollapsibleSection>

      <CollapsibleSection
        id="diagnostics"
        title="🧪 Diagnostics & Inspector"
        open={sections.diagnostics}
        onToggle={toggleSection}
        hint="Collision stats, heatmap, tracer export"
      >
        <DiagnosticsPanel {...props} />
      </CollapsibleSection>

      <CollapsibleSection
        id="export"
        title="🎬 Video Export"
        open={sections.export}
        onToggle={toggleSection}
        hint="Offline composite render to WebM/MP4"
      >
        <ExportPanel {...props} />
      </CollapsibleSection>

      <CollapsibleSection
        id="viewport"
        title="⚙ Viewport"
        open={sections.viewport}
        onToggle={toggleSection}
        hint="Canvas shape, MSAA, quarter zoom"
      >
        <ViewportPanel {...props} />
      </CollapsibleSection>
    </div>
  );
}
