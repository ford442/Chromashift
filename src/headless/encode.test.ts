import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { detectFfmpeg, ffmpegSink, pngSequenceSink, type RgbaFrame } from './encode';

/** Larger than a pipe's high-water mark, so every write waits for a drain. */
const FRAME: RgbaFrame = { width: 256, height: 256, data: new Uint8Array(256 * 256 * 4).fill(200) };
const OPTIONS = { width: FRAME.width, height: FRAME.height, fps: 30 };

let dir: string;
/** Stands in for ffmpeg: copies stdin to the last argument, the output path. */
let fakeEncoder: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chromashift-encode-'));
  fakeEncoder = join(dir, 'fake-ffmpeg.mjs');
  await writeFile(
    fakeEncoder,
    "#!/usr/bin/env node\nimport { createWriteStream } from 'node:fs';\n"
      + 'process.stdin.pipe(createWriteStream(process.argv.at(-1)));\n',
  );
  await chmod(fakeEncoder, 0o755);
});

afterAll(() => rm(dir, { recursive: true, force: true }));

describe('ffmpegSink', () => {
  it('pipes every frame to the encoder, creating the output folder', async () => {
    const out = join(dir, 'nested', 'clip.mp4');
    const sink = await ffmpegSink(fakeEncoder, out, OPTIONS);
    for (let i = 0; i < 12; i += 1) await sink.write(FRAME);
    await sink.close();
    expect((await stat(out)).size).toBe(12 * FRAME.data.byteLength);
  });

  // ffmpeg that cannot open its output exits at once; the render must stop,
  // not wait on a pipe nobody reads.
  it('fails the next write when the encoder dies', async () => {
    // Node, handed ffmpeg's arguments, refuses them and exits.
    const sink = await ffmpegSink(process.execPath, join(dir, 'dead.mp4'), OPTIONS);
    const writeAll = async () => {
      for (let i = 0; i < 100; i += 1) await sink.write(FRAME);
    };
    await expect(writeAll()).rejects.toThrow(/ffmpeg exited with \d+ before the clip ended/);
    await expect(sink.close()).rejects.toThrow(/ffmpeg exited with/);
  });

  it('refuses a frame of another size', async () => {
    const sink = await ffmpegSink(fakeEncoder, join(dir, 'sized.mp4'), OPTIONS);
    await expect(sink.write({ ...FRAME, width: 128 })).rejects.toThrow(/encoder was opened at 256×256/);
    await sink.close();
  });

  it('refuses a container it has no codec for', async () => {
    await expect(ffmpegSink(fakeEncoder, join(dir, 'clip.gif'), OPTIONS)).rejects.toThrow(/Unknown video container/);
  });
});

describe('detectFfmpeg', () => {
  it('is null when the binary is missing or is not ffmpeg', () => {
    expect(detectFfmpeg({ CHROMASHIFT_FFMPEG: join(dir, 'no-such-ffmpeg') })).toBeNull();
    expect(detectFfmpeg({ CHROMASHIFT_FFMPEG: process.execPath })).toBeNull();
  });
});

describe('pngSequenceSink', () => {
  it('writes numbered PNGs into a folder it creates', async () => {
    const frames = join(dir, 'frames');
    const sink = pngSequenceSink(frames);
    await sink.write(FRAME);
    await sink.write(FRAME);
    await sink.close();
    expect((await readdir(frames)).sort()).toEqual(['frame-00000.png', 'frame-00001.png']);
    const { data, info } = await sharp(await readFile(join(frames, 'frame-00001.png'))).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([256, 256, 4]);
    expect(data[0]).toBe(200);
  });
});
