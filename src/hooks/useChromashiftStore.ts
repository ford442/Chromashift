import { useEffect, useMemo, useReducer } from 'react';
import { chromashiftReducer } from '../state/chromashiftReducer';
import { createChromashiftActions } from '../state/actions';
import type { ChromashiftDispatch } from '../state/actions';
import { createInitialStateFromUrl } from '../state/presetUrl';
import { renderTelemetry } from '../engine/telemetryStore';
import type { ChromashiftRefs } from './refs/types';
import { useChromashiftRefs } from './refs/useChromashiftRefs';
import { applyClassificationMaskToRenderers, applySourceTexture } from './refs/textureRouting';
import {
  ensureReferenceImage,
  useHandleAngleChange,
  useHandleExtensionChange,
  useSelectSourceIndex,
} from './store/storeHelpers';

export type { ChromashiftRefs } from './refs/types';
export type { ChromashiftDispatch } from '../state/actions';
export { useChromashiftRefs, applySourceTexture, applyClassificationMaskToRenderers };

export function useChromashiftStore(refs: ChromashiftRefs) {
  // Lazy initializer applies any ?preset= URL parameter before the first
  // render commit, so a shared preset is live before the first frame.
  const [state, dispatch] = useReducer(chromashiftReducer, undefined, () => createInitialStateFromUrl());
  const {
    renderStateRef,
    engineModeRef,
    imageListRef,
    currentImageIndexRef,
    animAnglesRef,
  } = refs;

  useEffect(() => {
    renderStateRef.current = state;
  }, [renderStateRef, state]);

  useEffect(() => {
    engineModeRef.current = state.engine.engineMode;
  }, [engineModeRef, state.engine.engineMode]);

  useEffect(() => {
    imageListRef.current = state.media.imageList;
  }, [imageListRef, state.media.imageList]);

  useEffect(() => {
    currentImageIndexRef.current = state.media.currentIndex;
  }, [currentImageIndexRef, state.media.currentIndex]);

  useEffect(() => {
    // `state.layers.angles` only changes on a manual knob drag, a preset load, or
    // reset (the render loop no longer dispatches into it — see telemetryStore.ts)
    // — so push it to the ref the loop reads and the store the knob displays,
    // rather than waiting for the loop's next periodic sync.
    const angles = state.layers.angles;
    animAnglesRef.current = [...angles];
    renderTelemetry.setAngles([...angles]);
  }, [animAnglesRef, state.layers.angles]);

  const actions = useMemo(() => createChromashiftActions(dispatch), []);

  const selectSourceIndex = useSelectSourceIndex(dispatch, imageListRef, currentImageIndexRef);
  const handleAngleChange = useHandleAngleChange(dispatch, animAnglesRef);
  const handleExtensionChange = useHandleExtensionChange(dispatch);

  return {
    state,
    dispatch: dispatch as ChromashiftDispatch,
    actions,
    selectSourceIndex,
    handleAngleChange,
    handleExtensionChange,
    ensureReferenceImage,
  };
}

export type ChromashiftStore = ReturnType<typeof useChromashiftStore>;
