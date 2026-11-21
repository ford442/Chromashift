import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderTelemetry } from '../../engine/telemetryStore';
import { EMPTY_GPU_RENDER_TIMING, type GpuPassTimings } from '../../engine/types/RendererContracts';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import type { DiagnosticsPanelProps } from './types';

const noop = () => {};

const PROPS = {
  diagnosticsMode: false,
  diagnosticsOpacity: 0.5,
  stampBoost: 1.8,
  peakCollisionsOnly: false,
  isPaused: false,
  mainViewMode: 0,
  exportingTracer: false,
  tracerInspectHeatmap: false,
  tracerInspectZoom: 1,
  tracerInspectExposure: 1,
  tracerInspectTonemap: false,
  tracerInspectShowLayers: false,
  performanceHudEnabled: true,
  performanceAutoDegrade: false,
  frameRate: 60,
  rendererBackend: 'webgpu',
  onDiagnosticsModeChange: noop,
  onDiagnosticsOpacityChange: noop,
  onStampBoostChange: noop,
  onPeakCollisionsOnlyChange: noop,
  onPerformanceHudToggle: noop,
  onPerformanceAutoDegradeToggle: noop,
  onApplyPerformanceDegrade: noop,
  onFreezeInspect: noop,
  onExportTracer: () => Promise.resolve(),
  onExportStill: () => Promise.resolve(),
  onTracerInspectHeatmapToggle: noop,
  onTracerInspectZoomChange: noop,
  onTracerInspectExposureChange: noop,
  onTracerInspectTonemapToggle: noop,
  onTracerInspectShowLayersToggle: noop,
  onResetInspectView: noop,
} satisfies DiagnosticsPanelProps;

const TIMINGS: GpuPassTimings = {
  layersMs: 1,
  motionMs: 0.2,
  motionFlowMs: 0,
  particleEmitMs: 0.12,
  particleAdvectMs: 0.34,
  particleSplatMs: 0.56,
  persistenceMs: 1.5,
  compositorMs: 1,
  readbackMs: 0.1,
  totalGpuMs: 4.82,
};

afterEach(() => {
  act(() => renderTelemetry.setRenderGpuTiming(EMPTY_GPU_RENDER_TIMING));
});

describe('the Perf HUD', () => {
  it('has a row for each of the particle chain’s passes, from the timestamp profiler', () => {
    render(<DiagnosticsPanel {...PROPS} />);
    act(() => renderTelemetry.setRenderGpuTiming({
      available: true,
      last: TIMINGS,
      history: [4.82],
      approxBandwidthMBps: 0,
    }));
    expect(screen.getByText('Emit')).toBeTruthy();
    expect(screen.getByText('Advect')).toBeTruthy();
    expect(screen.getByText('Splat')).toBeTruthy();
    expect(screen.getByTestId('perf-hud-emit-ms').textContent).toBe('0.12 ms');
    expect(screen.getByTestId('perf-hud-advect-ms').textContent).toBe('0.34 ms');
    expect(screen.getByTestId('perf-hud-splat-ms').textContent).toBe('0.56 ms');
  });
});
