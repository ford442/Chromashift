import type { ChromashiftActions } from '../../state/actions';
import type { ChromashiftState } from '../../state/types';
import type { AppUIPreviewStripProps } from '../../components/AppUI.types';

export function buildPreviewStripProps(
  state: ChromashiftState,
  actions: ChromashiftActions,
): AppUIPreviewStripProps {
  const { output } = state;

  return {
    tracerPreviewFrozen: output.tracerPreviewFrozen,
    setTracerPreviewFrozen: actions.setTracerPreviewFrozen,
    livePreviewEnabled: output.livePreviewEnabled,
    setLivePreviewEnabled: actions.setLivePreviewEnabled,
  };
}
