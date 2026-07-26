/** Preferred MediaRecorder MIME types, highest quality first. */
const RECORDER_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4',
] as const;

const WEBCODECS_VP9_CODEC = 'vp09.00.10.08';
const WEBCODECS_VP8_CODEC = 'vp8';
const WEBCODECS_AVC_CODEC = 'avc1.42E01E';

export type VideoExportContainer = 'auto' | 'webm' | 'mp4';
export type VideoExportQuality = 'high' | 'medium' | 'low';
export type VideoExportPath = 'webcodecs' | 'mediarecorder';

export interface VideoCodecSupport {
  mediaRecorder: boolean;
  webCodecs: boolean;
  webCodecsUsable: boolean;
  preferredPath: VideoExportPath | null;
  webCodecsContainer: 'webm' | 'mp4' | null;
  webCodecsCodec: string | null;
  preferredMimeType: string | null;
  supportedMimeTypes: string[];
  encodingLabel: string | null;
}

export type VideoExportCapabilities = VideoCodecSupport;

function probeMediaRecorderSupport(): Pick<
  VideoCodecSupport,
  'mediaRecorder' | 'preferredMimeType' | 'supportedMimeTypes'
> {
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

  return {
    mediaRecorder: supportedMimeTypes.length > 0,
    preferredMimeType,
    supportedMimeTypes,
  };
}

async function isVideoEncoderConfigSupported(
  codec: string,
  width: number,
  height: number,
): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined' || !VideoEncoder.isConfigSupported) {
    return false;
  }
  const result = await VideoEncoder.isConfigSupported({
    codec,
    width,
    height,
    bitrate: 4_000_000,
  });
  return Boolean(result?.supported);
}

async function probeWebCodecsAtSize(
  width: number,
  height: number,
): Promise<Pick<
  VideoCodecSupport,
  'webCodecsUsable' | 'preferredPath' | 'webCodecsContainer' | 'webCodecsCodec' | 'encodingLabel'
>> {
  const webCodecs = typeof VideoEncoder !== 'undefined';
  if (!webCodecs) {
    return {
      webCodecsUsable: false,
      preferredPath: null,
      webCodecsContainer: null,
      webCodecsCodec: null,
      encodingLabel: null,
    };
  }

  const vp9 = await isVideoEncoderConfigSupported(WEBCODECS_VP9_CODEC, width, height);
  const vp8 = await isVideoEncoderConfigSupported(WEBCODECS_VP8_CODEC, width, height);
  const avc = await isVideoEncoderConfigSupported(WEBCODECS_AVC_CODEC, width, height);

  if (vp9) {
    return {
      webCodecsUsable: true,
      preferredPath: 'webcodecs',
      webCodecsContainer: 'webm',
      webCodecsCodec: 'vp9',
      encodingLabel: 'WebCodecs (VP9 WebM)',
    };
  }
  if (vp8) {
    return {
      webCodecsUsable: true,
      preferredPath: 'webcodecs',
      webCodecsContainer: 'webm',
      webCodecsCodec: 'vp8',
      encodingLabel: 'WebCodecs (VP8 WebM)',
    };
  }
  if (avc) {
    return {
      webCodecsUsable: true,
      preferredPath: 'webcodecs',
      webCodecsContainer: 'mp4',
      webCodecsCodec: 'avc',
      encodingLabel: 'WebCodecs (H.264 MP4)',
    };
  }

  return {
    webCodecsUsable: false,
    preferredPath: null,
    webCodecsContainer: null,
    webCodecsCodec: null,
    encodingLabel: null,
  };
}

function buildSyncCodecSupport(
  recorder: ReturnType<typeof probeMediaRecorderSupport>,
): VideoCodecSupport {
  const webCodecs = typeof VideoEncoder !== 'undefined';
  const encodingLabel = recorder.preferredMimeType
    ? `MediaRecorder (${recorder.preferredMimeType})`
    : null;

  return {
    ...recorder,
    webCodecs,
    webCodecsUsable: false,
    preferredPath: recorder.mediaRecorder ? 'mediarecorder' : null,
    webCodecsContainer: null,
    webCodecsCodec: null,
    encodingLabel,
  };
}

/** Fast synchronous probe for initial panel render. */
export function detectVideoCodecSupport(): VideoCodecSupport {
  return buildSyncCodecSupport(probeMediaRecorderSupport());
}

/** Async probe at export resolution; prefers WebCodecs when encodable. */
export async function probeVideoExportCapabilities(
  width: number,
  height: number,
): Promise<VideoExportCapabilities> {
  const recorder = probeMediaRecorderSupport();
  const webCodecsProbe = await probeWebCodecsAtSize(width, height);

  if (webCodecsProbe.webCodecsUsable) {
    return {
      ...recorder,
      webCodecs: true,
      ...webCodecsProbe,
    };
  }

  const sync = buildSyncCodecSupport(recorder);
  return {
    ...sync,
    preferredPath: recorder.mediaRecorder ? 'mediarecorder' : null,
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

/** Resolve container for WebCodecs export from user preference and capability. */
export function resolveWebCodecsContainer(
  preference: VideoExportContainer,
  caps: Pick<VideoCodecSupport, 'webCodecsContainer' | 'preferredMimeType'>,
): 'webm' | 'mp4' {
  if (preference === 'webm' || preference === 'mp4') {
    return preference;
  }
  if (caps.webCodecsContainer) {
    return caps.webCodecsContainer;
  }
  if (caps.preferredMimeType?.includes('mp4')) {
    return 'mp4';
  }
  return 'webm';
}
