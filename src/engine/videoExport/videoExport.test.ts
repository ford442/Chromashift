import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceAnglesBy } from '../WasmEngine';
import {
  detectVideoCodecSupport,
  evenDimension,
  extensionForMimeType,
  probeVideoExportCapabilities,
  resolveWebCodecsContainer,
} from './videoCodecs';

describe('videoCodecs', () => {
  it('rounds dimensions to even values', () => {
    expect(evenDimension(1023)).toBe(1022);
    expect(evenDimension(1024)).toBe(1024);
    expect(evenDimension(1)).toBe(2);
  });

  it('maps mime types to extensions', () => {
    expect(extensionForMimeType('video/webm;codecs=vp9')).toBe('webm');
    expect(extensionForMimeType('video/mp4;codecs=avc1')).toBe('mp4');
  });

  it('resolves auto container from capability probe', () => {
    expect(resolveWebCodecsContainer('auto', {
      webCodecsContainer: 'webm',
      preferredMimeType: 'video/webm;codecs=vp9',
    })).toBe('webm');
    expect(resolveWebCodecsContainer('auto', {
      webCodecsContainer: null,
      preferredMimeType: 'video/mp4;codecs=avc1',
    })).toBe('mp4');
    expect(resolveWebCodecsContainer('mp4', {
      webCodecsContainer: 'webm',
      preferredMimeType: null,
    })).toBe('mp4');
  });
});

describe('probeVideoExportCapabilities', () => {
  class FakeVideoEncoder {
    static isConfigSupported = vi.fn(async (config: { codec: string }) => ({
      supported: config.codec === 'vp09.00.10.08',
    }));
  }

  class FakeMediaRecorder {
    static isTypeSupported(mime: string): boolean {
      return mime.startsWith('video/webm');
    }
  }

  beforeEach(() => {
    vi.stubGlobal('VideoEncoder', FakeVideoEncoder);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers WebCodecs when VP9 is supported at probe size', async () => {
    const caps = await probeVideoExportCapabilities(640, 480);
    expect(caps.preferredPath).toBe('webcodecs');
    expect(caps.webCodecsUsable).toBe(true);
    expect(caps.webCodecsContainer).toBe('webm');
    expect(caps.webCodecsCodec).toBe('vp9');
  });

  it('falls back to MediaRecorder when WebCodecs is unavailable', async () => {
    FakeVideoEncoder.isConfigSupported = vi.fn(async () => ({ supported: false }));
    const caps = await probeVideoExportCapabilities(640, 480);
    expect(caps.preferredPath).toBe('mediarecorder');
    expect(caps.webCodecsUsable).toBe(false);
    expect(caps.mediaRecorder).toBe(true);
  });
});

describe('detectVideoCodecSupport', () => {
  class FakeMediaRecorder {
    static isTypeSupported(mime: string): boolean {
      return mime.startsWith('video/webm');
    }
  }

  beforeEach(() => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('VideoEncoder', class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports sync capability flags for the export panel', () => {
    const caps = detectVideoCodecSupport();
    expect(caps.mediaRecorder).toBe(true);
    expect(caps.webCodecs).toBe(true);
    expect(caps.preferredMimeType).toBe('video/webm;codecs=vp9');
  });
});

describe('deterministic angle stepping', () => {
  const extensions: [number, number, number] = [130, 230, 330];
  const start: [number, number, number] = [0, 0, 0];

  it('produces identical sequences in TypeScript mode', () => {
    let a = [...start] as [number, number, number];
    let b = [...start] as [number, number, number];
    for (let i = 0; i < 150; i += 1) {
      a = advanceAnglesBy(a, extensions, false);
      b = advanceAnglesBy(b, extensions, false);
      expect(a).toEqual(b);
    }
  });
});
