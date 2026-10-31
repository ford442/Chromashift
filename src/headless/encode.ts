import { spawn, spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { once } from 'node:events';

import { writePngFile } from './image';

export interface RgbaFrame {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Where rendered frames go: an encoder, or a folder of PNGs. */
export interface FrameSink {
  /** What is writing, for the log line. */
  readonly describe: string;
  write(frame: RgbaFrame): Promise<void>;
  close(): Promise<void>;
}

/**
 * The system `ffmpeg`, or `null`. `CHROMASHIFT_FFMPEG` names another binary.
 * It is optional: without it the CLI writes a PNG sequence.
 */
export function detectFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  const binary = env.CHROMASHIFT_FFMPEG || 'ffmpeg';
  const probe = spawnSync(binary, ['-hide_banner', '-version'], { stdio: 'ignore' });
  return probe.status === 0 ? binary : null;
}

/**
 * Output codec arguments by container. Frames are tagged BT.709 limited range,
 * which is what a browser's WebCodecs encode of an sRGB canvas produces, so a
 * player shows the CLI clip and the in-app export alike.
 */
function codecArgs(path: string): string[] {
  const colour = [
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  ];
  switch (extname(path).toLowerCase()) {
    case '.webm':
      return [...colour, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-row-mt', '1'];
    case '.mp4':
    case '.mov':
    case '.mkv':
      return [...colour, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart'];
    default:
      throw new Error(`Unknown video container "${extname(path)}" — use .mp4, .mov, .mkv or .webm.`);
  }
}

/**
 * Pipe raw RGBA frames into `ffmpeg`'s stdin. Backpressure is honoured, so a
 * slow encoder throttles the renderer instead of buffering the clip in memory,
 * and an encoder that dies mid-clip (a path it cannot write, a codec it lacks)
 * fails the next write instead of leaving it waiting on a pipe nobody reads.
 */
export async function ffmpegSink(
  ffmpeg: string,
  path: string,
  options: { width: number; height: number; fps: number },
): Promise<FrameSink> {
  await mkdir(dirname(path), { recursive: true });
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${options.width}x${options.height}`, '-r', String(options.fps),
    '-i', 'pipe:0',
    ...codecArgs(path),
    path,
  ];
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  let gone = false;
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => {
    gone = true;
  });
  const failure = exited.then(
    (code) => new Error(`ffmpeg exited with ${code} before the clip ended: ${stderr.trim()}`),
    (error: unknown) => error,
  );
  // EPIPE once ffmpeg has gone; `failure` says why.
  child.stdin.on('error', () => {});

  return {
    describe: `ffmpeg → ${path}`,
    async write(frame) {
      if (frame.width !== options.width || frame.height !== options.height) {
        throw new Error(`Frame is ${frame.width}×${frame.height}; the encoder was opened at ${options.width}×${options.height}.`);
      }
      if (gone) throw await failure;
      const bytes = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      if (child.stdin.write(bytes)) return;
      const drained = await Promise.race([
        once(child.stdin, 'drain').then(() => true, () => false),
        failure.then(() => false),
      ]);
      if (!drained) throw await failure;
    },
    async close() {
      child.stdin.end();
      const code = await exited;
      if (code !== 0) throw new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`);
    },
  };
}

/** Each frame as `frame-00000.png` in `dir` — the encoder-free fallback. */
export function pngSequenceSink(dir: string): FrameSink {
  let index = 0;
  let ready: Promise<unknown> | null = null;
  return {
    describe: `PNG sequence → ${dir}/`,
    async write(frame) {
      ready ??= mkdir(dir, { recursive: true });
      await ready;
      await writePngFile(join(dir, `frame-${String(index).padStart(5, '0')}.png`), frame);
      index += 1;
    },
    async close() {},
  };
}
