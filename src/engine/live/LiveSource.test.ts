import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeVideoAverageLuminance, LiveSourceManager } from './LiveSource';

/**
 * `LiveSourceManager` touches `document.createElement('video')`, `navigator.mediaDevices`,
 * and `URL.createObjectURL` — none of which exist in vitest's default `node` test
 * environment (no jsdom dependency in this repo). Rather than pull in jsdom, stub the
 * narrow DOM/media surface `LiveSource.ts` actually calls.
 */

class FakeTrack {
  label: string;
  stopped = false;
  private endedListeners: Array<() => void> = [];

  constructor(label: string) {
    this.label = label;
  }

  stop(): void {
    this.stopped = true;
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.endedListeners.push(listener);
  }

  fireEnded(): void {
    for (const listener of this.endedListeners) listener();
  }
}

class FakeMediaStream {
  private readonly tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }
  getTracks(): FakeTrack[] { return this.tracks; }
  getVideoTracks(): FakeTrack[] { return this.tracks; }
}

class FakeVideoElement {
  muted = false;
  playsInline = false;
  loop = false;
  src = '';
  srcObject: unknown = null;
  videoWidth = 0;
  videoHeight = 0;
  paused = true;

  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') this.src = '';
  });
  load = vi.fn();
}

describe('LiveSource', () => {
  let fakeVideo: FakeVideoElement;
  let getUserMedia: ReturnType<typeof vi.fn>;
  let getDisplayMedia: ReturnType<typeof vi.fn>;
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeVideo = new FakeVideoElement();
    getUserMedia = vi.fn();
    getDisplayMedia = vi.fn();
    createObjectURL = vi.fn(() => 'blob:mock-url');
    revokeObjectURL = vi.fn();

    vi.stubGlobal('document', {
      createElement: vi.fn(() => fakeVideo),
    });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia, getDisplayMedia },
    });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('startCamera', () => {
    it('routes through getUserMedia and reports the track label', async () => {
      const track = new FakeTrack('Integrated Webcam');
      getUserMedia.mockResolvedValue(new FakeMediaStream([track]));

      const manager = new LiveSourceManager();
      const result = await manager.startCamera();

      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(result.label).toBe('Integrated Webcam');
      expect(manager.kind).toBe('camera');
      expect(manager.active).toBe(true);
      expect(fakeVideo.srcObject).toBeInstanceOf(FakeMediaStream);
      expect(fakeVideo.loop).toBe(false);
    });

    it('throws when the browser has no getUserMedia', async () => {
      vi.stubGlobal('navigator', { mediaDevices: {} });
      const manager = new LiveSourceManager();
      await expect(manager.startCamera()).rejects.toThrow(/not supported/i);
    });
  });

  describe('startScreenShare', () => {
    it('routes through getDisplayMedia and reports kind "screen"', async () => {
      getDisplayMedia.mockResolvedValue(new FakeMediaStream([new FakeTrack('Screen 1')]));

      const manager = new LiveSourceManager();
      const result = await manager.startScreenShare();

      expect(getDisplayMedia).toHaveBeenCalledTimes(1);
      expect(result.label).toBe('Screen 1');
      expect(manager.kind).toBe('screen');
    });
  });

  describe('loadVideoFile', () => {
    it('creates an object URL, loops, and reports kind "video-file"', async () => {
      const file = { name: 'clip.mp4' } as File;
      const manager = new LiveSourceManager();

      const result = await manager.loadVideoFile(file);

      expect(createObjectURL).toHaveBeenCalledWith(file);
      expect(result.label).toBe('clip.mp4');
      expect(manager.kind).toBe('video-file');
      expect(fakeVideo.loop).toBe(true);
      expect(fakeVideo.src).toBe('blob:mock-url');
    });
  });

  describe('source switching and teardown', () => {
    it('stops the previous stream when starting a new source', async () => {
      const camTrack = new FakeTrack('Camera');
      getUserMedia.mockResolvedValue(new FakeMediaStream([camTrack]));
      getDisplayMedia.mockResolvedValue(new FakeMediaStream([new FakeTrack('Screen')]));

      const manager = new LiveSourceManager();
      await manager.startCamera();
      await manager.startScreenShare();

      expect(camTrack.stopped).toBe(true);
      expect(manager.kind).toBe('screen');
    });

    it('stop() releases tracks, revokes object URLs, and clears kind/active', async () => {
      const file = { name: 'clip.mp4' } as File;
      const manager = new LiveSourceManager();
      await manager.loadVideoFile(file);

      manager.stop();

      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
      expect(fakeVideo.pause).toHaveBeenCalled();
      expect(fakeVideo.srcObject).toBeNull();
      expect(manager.kind).toBeNull();
      expect(manager.active).toBe(false);
    });

    it('invokes onEnded when the video track ends externally', async () => {
      const track = new FakeTrack('Screen 1');
      getDisplayMedia.mockResolvedValue(new FakeMediaStream([track]));
      const onEnded = vi.fn();
      const manager = new LiveSourceManager(onEnded);

      await manager.startScreenShare();
      track.fireEnded();

      expect(onEnded).toHaveBeenCalledTimes(1);
    });
  });

  describe('frameSize', () => {
    it('is null until the video reports a decoded frame', async () => {
      getUserMedia.mockResolvedValue(new FakeMediaStream([new FakeTrack('Cam')]));
      const manager = new LiveSourceManager();
      expect(manager.frameSize).toBeNull();

      await manager.startCamera();
      fakeVideo.videoWidth = 1280;
      fakeVideo.videoHeight = 720;
      expect(manager.frameSize).toEqual({ width: 1280, height: 720 });
    });
  });
});

describe('computeVideoAverageLuminance', () => {
  it('returns the neutral default before any frame has decoded', () => {
    const video = { videoWidth: 0, videoHeight: 0 } as HTMLVideoElement;
    expect(computeVideoAverageLuminance(video, false)).toBe(128);
  });
});
