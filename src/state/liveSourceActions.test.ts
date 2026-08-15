import { describe, expect, it } from 'vitest';
import { chromashiftReducer, createInitialState } from './chromashiftReducer';
import { createChromashiftActions } from './actions';

describe('media.liveSource', () => {
  it('defaults to inactive with no kind/error', () => {
    const state = createInitialState();
    expect(state.media.liveSource).toEqual({
      active: false,
      kind: null,
      label: null,
      width: 0,
      height: 0,
      error: null,
    });
  });

  it('media/patchLiveSource merges into the existing liveSource slice', () => {
    const state = createInitialState();
    const next = chromashiftReducer(state, {
      type: 'media/patchLiveSource',
      patch: { active: true, kind: 'camera', label: 'Integrated Webcam' },
    });

    expect(next.media.liveSource).toMatchObject({
      active: true,
      kind: 'camera',
      label: 'Integrated Webcam',
    });
    // Untouched fields are preserved from the previous slice.
    expect(next.media.liveSource.width).toBe(0);
    expect(next.media.liveSource.error).toBeNull();
    // Other media fields are untouched.
    expect(next.media.imageList).toBe(state.media.imageList);
  });

  it('a second patch merges on top of the first rather than replacing it', () => {
    let state = createInitialState();
    state = chromashiftReducer(state, {
      type: 'media/patchLiveSource',
      patch: { active: true, kind: 'video-file', label: 'clip.mp4', width: 640, height: 360 },
    });
    state = chromashiftReducer(state, {
      type: 'media/patchLiveSource',
      patch: { width: 1280, height: 720 },
    });

    expect(state.media.liveSource).toMatchObject({
      active: true,
      kind: 'video-file',
      label: 'clip.mp4',
      width: 1280,
      height: 720,
    });
  });

  it('setLiveSource action dispatches a media/patchLiveSource patch', () => {
    const actions: Array<{ type: string; patch?: unknown }> = [];
    const dispatch = (action: { type: string; patch?: unknown }) => actions.push(action);
    const chromashiftActions = createChromashiftActions(dispatch as never);

    chromashiftActions.setLiveSource({ active: false, kind: null, error: 'Camera permission denied' });

    expect(actions).toEqual([
      { type: 'media/patchLiveSource', patch: { active: false, kind: null, error: 'Camera permission denied' } },
    ]);
  });
});
