import { describe, expect, it } from 'vitest';
import {
  LIVE_SOURCE_CACHE_KEY,
  shouldRecreateVideoTexture,
  videoFrameSizeKey,
} from './liveSourceTexture';

describe('liveSourceTexture', () => {
  it('exposes a stable, non-URL cache key', () => {
    expect(LIVE_SOURCE_CACHE_KEY).toBe('__live-source__');
    expect(LIVE_SOURCE_CACHE_KEY.startsWith('blob:')).toBe(false);
    expect(LIVE_SOURCE_CACHE_KEY.startsWith('http')).toBe(false);
  });

  describe('videoFrameSizeKey', () => {
    it('encodes width and height', () => {
      expect(videoFrameSizeKey(1280, 720)).toBe('1280x720');
      expect(videoFrameSizeKey(640, 480)).not.toBe(videoFrameSizeKey(480, 640));
    });
  });

  describe('shouldRecreateVideoTexture', () => {
    it('recreates when there is no previous texture', () => {
      expect(shouldRecreateVideoTexture(undefined, 640, 480)).toBe(true);
    });

    it('does not recreate when the frame size is unchanged', () => {
      const key = videoFrameSizeKey(640, 480);
      expect(shouldRecreateVideoTexture(key, 640, 480)).toBe(false);
    });

    it('recreates when the camera/screen resolution changes', () => {
      const key = videoFrameSizeKey(640, 480);
      expect(shouldRecreateVideoTexture(key, 1280, 720)).toBe(true);
    });
  });
});
