/**
 * Ask the browser what colour space a source image was encoded in, without
 * guessing. WebCodecs `ImageDecoder` with `colorSpaceConversion: 'none'`
 * leaves the decoded frame in the file's own space and reports its primaries;
 * anything short of that answer — no `ImageDecoder`, an unsupported type, a
 * fetch or decode error, unknown primaries — is "not reported" (`null`).
 */
import { reportedSpaceFromPrimaries, type ReportedImageColorSpace } from './presentation';

interface DecodedFrame { colorSpace?: { primaries?: string | null }; close(): void }
interface ImageDecoderLike { decode(): Promise<{ image: DecodedFrame }>; close(): void }
type ImageDecoderCtor = {
  new (init: { data: ArrayBuffer; type: string; colorSpaceConversion?: 'none' | 'default' }): ImageDecoderLike;
  isTypeSupported?(type: string): Promise<boolean>;
};

export async function detectImageColorSpace(url: string): Promise<ReportedImageColorSpace> {
  const Decoder = (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;
  if (!Decoder || typeof fetch !== 'function') return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!type || (Decoder.isTypeSupported && !(await Decoder.isTypeSupported(type)))) return null;
    const decoder = new Decoder({ data: await response.arrayBuffer(), type, colorSpaceConversion: 'none' });
    try {
      const { image } = await decoder.decode();
      const primaries = image.colorSpace?.primaries;
      image.close();
      return reportedSpaceFromPrimaries(primaries);
    } finally {
      decoder.close();
    }
  } catch {
    return null;
  }
}
