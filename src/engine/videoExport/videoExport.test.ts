import { describe, expect, it } from 'vitest';
import { advanceAnglesBy } from '../WasmEngine';
import { evenDimension, extensionForMimeType } from './videoCodecs';

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
