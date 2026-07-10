/** Preferred MediaRecorder MIME types, highest quality first. */
const RECORDER_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4',
] as const;

export interface VideoCodecSupport {
  mediaRecorder: boolean;
  webCodecs: boolean;
  preferredMimeType: string | null;
  supportedMimeTypes: string[];
}

/** Probe browser video encoding capabilities for export. */
export function detectVideoCodecSupport(): VideoCodecSupport {
  const supportedMimeTypes: string[] = [];
  let preferredMimeType: string | null = null;

  if (typeof MediaRecorder !== 'undefined') {
    for (const mime of RECORDER_MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(mime)) {
        supportedMimeTypes.push(mime);
        preferredMimeType ??= mime;
      }
    }
  }

  const webCodecs = typeof VideoEncoder !== 'undefined';

  return {
    mediaRecorder: supportedMimeTypes.length > 0,
    webCodecs,
    preferredMimeType,
    supportedMimeTypes,
  };
}

/** Pick the best MediaRecorder MIME type available in this browser. */
export function pickRecorderMimeType(): string | null {
  return detectVideoCodecSupport().preferredMimeType;
}

/** File extension that matches the chosen recorder MIME type. */
export function extensionForMimeType(mimeType: string | null): string {
  if (!mimeType) return 'webm';
  if (mimeType.includes('mp4')) return 'mp4';
  return 'webm';
}

/** Round dimensions to even values (required by several video codecs). */
export function evenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}
