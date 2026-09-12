import { memo } from 'react';
import { CollapsibleSection } from './CollapsibleSection';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ExportPanel } from './ExportPanel';
import { LayerPanel } from './LayerPanel';
import { PlayPanel } from './PlayPanel';
import { PresetsPanel } from './PresetsPanel';
import { ReactivePanel } from './ReactivePanel';
import { RendererPanel } from './RendererPanel';
import { TracerPanel } from './TracerPanel';
import { UpscalePanel } from './UpscalePanel';
import { ViewportPanel } from './ViewportPanel';
import type { OverlayProps } from './types';
import { useOverlaySections } from './useOverlaySections';
import { useRenderCount } from '../../debug/renderCounts';
import {
  selectDiagnosticsPanelProps,
  selectExportPanelProps,
  selectLayerPanelProps,
  selectPlayPanelProps,
  selectPresetsPanelProps,
  selectReactivePanelProps,
  selectRendererPanelProps,
  selectTracerPanelProps,
  selectUpscalePanelProps,
  selectViewportPanelProps,
} from './panelProps';

export const NunifOverlay = memo(function NunifOverlay(props: OverlayProps) {
  useRenderCount('NunifOverlay');
  const { sections, toggleSection } = useOverlaySections();

  // One narrowed prop slice per panel. `memo` compares a panel's props
  // shallowly, so narrowing is what makes the wrappers bite: `TracerPanel`
  // re-renders when a tracer field moves and not when the compare layout does.
  // Spreading the whole bag (`<TracerPanel {...props} />`) made every panel's
  // `memo` miss on every unrelated change.
  const playProps = selectPlayPanelProps(props);
  const rendererProps = selectRendererPanelProps(props);
  const layerProps = selectLayerPanelProps(props);
  const tracerProps = selectTracerPanelProps(props);
  const reactiveProps = selectReactivePanelProps(props);
  const upscaleProps = selectUpscalePanelProps(props);
  const diagnosticsProps = selectDiagnosticsPanelProps(props);
  const exportProps = selectExportPanelProps(props);
  const presetsProps = selectPresetsPanelProps(props);
  const viewportProps = selectViewportPanelProps(props);

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

      <PlayPanel {...playProps} />

      <CollapsibleSection
        id="renderer"
        title="🎛 Renderer & Engine"
        open={sections.renderer}
        onToggle={toggleSection}
      >
        <RendererPanel {...rendererProps} />
      </CollapsibleSection>

      <CollapsibleSection
        id="layers"
        title="🌍 Layers & Global"
        open={sections.layers}
        onToggle={toggleSection}
      >
        <LayerPanel {...layerProps} />
      </CollapsibleSection>

      <CollapsibleSection
        id="tracer"
        title="✨ Dual Tracer"
        open={sections.tracer}
        onToggle={toggleSection}
      >
        <TracerPanel {...tracerProps} />
      </CollapsibleSection>

      <CollapsibleSection
        id="reactive"
        title="🎵 Reactive Input"
        open={sections.reactive}
        onToggle={toggleSection}
        hint="Audio + MIDI performance control"
      >
        <ReactivePanel {...reactiveProps} />
      </CollapsibleSection>

      <CollapsibleSection
        id="upscale"
        title="🔍 Upscale"
        open={sections.upscale}
        onToggle={toggleSection}
        hint="Real-ESRGAN / waifu2x research tools"
      >
        <UpscalePanel {...upscaleProps} />
      </CollapsibleSection>

      <CollapsibleSection
        id="diagnostics"
        title="🧪 Diagnostics & Inspector"
        open={sections.diagnostics}
        onToggle={toggleSection}
        hint="Collision stats, heatmap, tracer export"
      >
        <DiagnosticsPanel {...diagnosticsProps} />
      </CollapsibleSection>

      <CollapsibleSection
        id="export"
        title="🎬 Video Export"
        open={sections.export}
        onToggle={toggleSection}
        hint="Offline composite render to WebM/MP4"
      >
        <ExportPanel {...exportProps} />
      </CollapsibleSection>

      <CollapsibleSection
        id="presets"
        title="💾 Presets"
        open={sections.presets}
        onToggle={toggleSection}
        hint="Save, share URL, gallery"
      >
        <PresetsPanel {...presetsProps} />
      </CollapsibleSection>

      <CollapsibleSection
        id="viewport"
        title="⚙ Viewport"
        open={sections.viewport}
        onToggle={toggleSection}
        hint="Canvas shape, MSAA, quarter zoom"
      >
        <ViewportPanel {...viewportProps} />
      </CollapsibleSection>
    </div>
  );
});
