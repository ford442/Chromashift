/**
 * Build {@link OverlayProps} with reference-stable callbacks.
 *
 * `buildOverlayProps` mostly forwards handlers that are already stable
 * (`state/actions/*` is memoized once, the `hooks/store` callbacks are
 * `useCallback`-wrapped), but a handful of props need a small wrapper — clamping
 * a view mode, writing one entry of the opacity triple, poking the renderer
 * alongside a dispatch. Built inline they would be fresh function identities on
 * every render, and that alone is enough to defeat every panel's `memo()`:
 * `NunifOverlay` hands each panel a narrowed prop slice, and `memo` compares
 * those slices shallowly, so one unstable callback re-renders the panel holding
 * it on every keystroke elsewhere in the app.
 *
 * Each wrapper below therefore gets a `useCallback` with honest dependencies.
 * Most close over nothing but stable actions and so never change identity;
 * `onLayerOpacityPerLayerChange` reads the current opacity triple, so it changes
 * exactly when that triple does — which is when `LayerPanel` has to re-render
 * anyway.
 */
import { useCallback } from 'react';
import { buildOverlayProps } from './buildOverlayProps';
import { MAIN_VIEW_MODES } from '../engine/viewModes';
import type { MainViewMode } from '../engine/viewModes';
import type { DisplayColorSpace } from '../engine/gpuOptions';
import type { LayerTriple } from '../state/types';
import type { AppUIProps } from './AppUI.types';
import type { OverlayProps } from './overlay/types';
import type { EngineMode, LayerIndex } from './overlay/types';

/**
 * The wrappers `buildOverlayProps` takes as an argument.
 *
 * The two that reach through `rendererRef` are deliberately *not* in here: the
 * `react-hooks/refs` lint cannot prove a callee won't invoke a ref-reading
 * callback during render, so they are attached to the finished object below
 * instead of being handed to a function.
 */
export interface StableOverlayHandlers {
  onTracerViewToggle: (next: boolean) => void;
  onMainViewModeChange: (value: number) => void;
  onEngineModeChange: (mode: EngineMode) => void;
  onLayerOpacityPerLayerChange: (layer: LayerIndex, opacity: number) => void;
  onDisplayColorSpaceChange: (space: DisplayColorSpace) => void;
  onViewportQuarterZoomToggle: (enabled: boolean) => void;
  onViewportHalfOverlayToggle: (enabled: boolean) => void;
}

/** Renderer-touching wrappers, spread onto the result rather than passed down. */
export type RendererOverlayHandlers = Pick<OverlayProps, 'onApplyPerformanceDegrade' | 'onAntialiasToggle'>;

export function useOverlayProps(props: AppUIProps): OverlayProps {
  const {
    applyPerformanceDegrade,
    isWasmReady,
    layerOpacities,
    rendererRef,
    setAntialiasEnabled,
    setDisplayColorSpace,
    setEngineMode,
    setLayerOpacities,
    setMainViewMode,
    setViewportHalfOverlay,
    setViewportQuarterZoom,
  } = props;

  const onTracerViewToggle = useCallback((next: boolean) => {
    setMainViewMode(next ? MAIN_VIEW_MODES.FULL_RES_TRACER : MAIN_VIEW_MODES.PROCESSED_COMPOSITE);
  }, [setMainViewMode]);

  const onMainViewModeChange = useCallback((value: number) => {
    setMainViewMode(value as MainViewMode);
  }, [setMainViewMode]);

  const onEngineModeChange = useCallback((mode: EngineMode) => {
    if (mode === 'wasm' && !isWasmReady()) return;
    setEngineMode(mode);
  }, [isWasmReady, setEngineMode]);

  const onLayerOpacityPerLayerChange = useCallback((layer: LayerIndex, opacity: number) => {
    const next = [...layerOpacities] as LayerTriple<number>;
    next[layer] = opacity;
    setLayerOpacities(next);
  }, [layerOpacities, setLayerOpacities]);

  const onApplyPerformanceDegrade = useCallback(() => {
    rendererRef.current?.setAntialiasing(false);
    applyPerformanceDegrade();
  }, [rendererRef, applyPerformanceDegrade]);

  const onAntialiasToggle = useCallback((enabled: boolean) => {
    setAntialiasEnabled(enabled);
    rendererRef.current?.setAntialiasing(enabled);
  }, [rendererRef, setAntialiasEnabled]);

  const onDisplayColorSpaceChange = useCallback((space: DisplayColorSpace) => {
    setDisplayColorSpace(space);
  }, [setDisplayColorSpace]);

  const onViewportQuarterZoomToggle = useCallback((enabled: boolean) => {
    setViewportQuarterZoom(enabled);
    if (enabled) setViewportHalfOverlay(false);
  }, [setViewportQuarterZoom, setViewportHalfOverlay]);

  const onViewportHalfOverlayToggle = useCallback((enabled: boolean) => {
    setViewportHalfOverlay(enabled);
    if (enabled) setViewportQuarterZoom(false);
  }, [setViewportHalfOverlay, setViewportQuarterZoom]);

  return {
    ...buildOverlayProps(props, {
      onTracerViewToggle,
      onMainViewModeChange,
      onEngineModeChange,
      onLayerOpacityPerLayerChange,
      onDisplayColorSpaceChange,
      onViewportQuarterZoomToggle,
      onViewportHalfOverlayToggle,
    }),
    onApplyPerformanceDegrade,
    onAntialiasToggle,
  };
}
