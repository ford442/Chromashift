import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';

import { presetGraphSource } from '../engine/graph';
import { isGraphPresetName, type GraphPresetName } from '../engine/graph/altGraphs';
import type { ExportPassMode } from '../engine/types/RendererContracts';
import { evenDimension } from '../engine/videoExport/videoCodecs';
import { detectFfmpeg, ffmpegSink, pngSequenceSink, type FrameSink } from './encode';
import {
  GOLDEN_CASES,
  GOLDEN_MAX_CHANNEL_DELTA,
  GOLDEN_MAX_DIFFERING_RATIO,
  compareGolden,
  goldenPath,
  loadGoldenFixture,
  readGolden,
  renderGoldenCase,
  writeGolden,
} from './goldens';
import { decodeImageFile, listImageFiles, writePngFile } from './image';
import { renderClip, renderStill } from './render';
import { openHeadlessSession, withSourceAnalysis, type HeadlessSession } from './session';
import { loadSettings } from './settings';

const USAGE = `chromashift — render Chromashift settings without a browser (docs/HEADLESS.md)

Usage:
  chromashift render [settings] --image <file|folder> --out <clip.mp4|clip.webm|frames/> [options]
  chromashift still  [settings] --image <file> --out <still.png> [options]
  chromashift golden [--update]

[settings] is a settings document (the JSON the Presets panel exports) or a
?preset= share string or URL. Without one, the session defaults.

Options:
  -i, --image <path>   Source image, or a folder of images (rendered in name order)
  -g, --graph <name>   Graph shape: default, blur, warp, smear, feedback, trails3
  -n, --frames <n>     render: frames per image (default 90)
                       still: frames rendered, the last one written (default 30)
      --fps <n>        Frames per second (default: the settings' export fps)
      --size <WxH>     Output size (default: the first image's, rounded to even)
      --pass <mode>    composite, tracers or layers (default composite)
      --no-tracers     Render without tracers (the export panel's toggle)
      --msaa           4x MSAA on the band layers
      --no-wasm        Analyse with the TypeScript kernels, not the C++ engine
      --swiftshader    Draw on the SwiftShader Vulkan Playwright's Chromium ships —
                       the E2E rasterizer, pixel for pixel (default for golden)
  -o, --out <path>     Output file; a path ending in / is a PNG sequence
      --update         golden: rewrite the goldens instead of comparing
  -h, --help

Environment: CHROMASHIFT_DAWN_FLAGS (Dawn options, e.g. backend=vulkan),
CHROMASHIFT_FFMPEG (the ffmpeg binary; without one, render writes PNGs).
`;

const PASS_MODES: readonly ExportPassMode[] = ['composite', 'tracers', 'layers'];

class UsageError extends Error {}

interface CommonOptions {
  settings: string | undefined;
  image: string | undefined;
  graph: GraphPresetName;
  frames: number | undefined;
  fps: number | undefined;
  size: { width: number; height: number } | undefined;
  passMode: ExportPassMode;
  includeTracers: boolean;
  msaa: boolean;
  wasm: boolean;
  swiftshader: boolean | undefined;
  out: string | undefined;
  update: boolean;
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`${flag} must be a positive integer, got "${value}".`);
  return parsed;
}

function parseSize(value: string | undefined): { width: number; height: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(value);
  if (!match) throw new UsageError(`--size must be WxH, got "${value}".`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseCommon(args: string[]): CommonOptions {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    allowNegative: true,
    options: {
      image: { type: 'string', short: 'i' },
      graph: { type: 'string', short: 'g', default: 'default' },
      frames: { type: 'string', short: 'n' },
      fps: { type: 'string' },
      size: { type: 'string' },
      pass: { type: 'string', default: 'composite' },
      tracers: { type: 'boolean', default: true },
      msaa: { type: 'boolean', default: false },
      wasm: { type: 'boolean', default: true },
      swiftshader: { type: 'boolean' },
      out: { type: 'string', short: 'o' },
      update: { type: 'boolean', default: false },
    },
  });
  if (positionals.length > 1) throw new UsageError(`Expected at most one settings argument, got ${positionals.length}.`);
  if (!isGraphPresetName(values.graph)) throw new UsageError(`Unknown graph "${values.graph}".`);
  const passMode = PASS_MODES.find((mode) => mode === values.pass);
  if (!passMode) throw new UsageError(`--pass must be one of ${PASS_MODES.join(', ')}.`);
  return {
    settings: positionals[0],
    image: values.image,
    graph: values.graph,
    frames: parsePositiveInt(values.frames, '--frames'),
    fps: parsePositiveInt(values.fps, '--fps'),
    size: parseSize(values.size),
    passMode,
    includeTracers: values.tracers,
    msaa: values.msaa,
    wasm: values.wasm,
    swiftshader: values.swiftshader,
    out: values.out,
    update: values.update,
  };
}

/** A settings argument is a file if one exists at that path, otherwise a `?preset=` string. */
async function readSettingsArgument(argument: string | undefined): Promise<string | undefined> {
  if (argument === undefined) return undefined;
  const isFile = await stat(argument).then((s) => s.isFile(), () => false);
  return isFile ? readFile(argument, 'utf8') : argument;
}

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function withSession<T>(
  options: CommonOptions,
  run: (session: HeadlessSession) => Promise<T>,
  swiftshaderByDefault = false,
): Promise<T> {
  const session = await openHeadlessSession({
    antialias: options.msaa,
    wasm: options.wasm,
    rasterizer: options.swiftshader ?? swiftshaderByDefault ? 'swiftshader' : 'system',
  });
  log(`chromashift: ${session.adapter} · analysis ${session.wasm ? 'C++ WASM engine' : 'TypeScript kernels'}`);
  try {
    return await run(session);
  } finally {
    session.close();
  }
}

async function prepare(options: CommonOptions) {
  if (!options.image) throw new UsageError('--image is required.');
  if (!options.out) throw new UsageError('--out is required.');
  const loaded = loadSettings(await readSettingsArgument(options.settings));
  for (const correction of loaded.corrections) log(`chromashift: settings corrected — ${correction}`);
  const isDirectory = await stat(options.image).then((s) => s.isDirectory(), () => {
    throw new UsageError(`No such image: ${options.image}`);
  });
  const images = await listImageFiles(options.image, isDirectory);
  if (images.length === 0) throw new UsageError(`No images in ${options.image}.`);
  return { state: loaded.state, images, out: options.out };
}

async function commandRender(options: CommonOptions): Promise<number> {
  const { state, images, out } = await prepare(options);
  const fps = options.fps ?? state.ui.videoExportSettings.fps;
  const framesPerImage = options.frames ?? 90;

  return withSession(options, async (session) => {
    session.setPassGraph(presetGraphSource(options.graph));
    let sink: FrameSink | null = null;
    let rendered = 0;
    const started = performance.now();
    try {
      for (const [index, path] of images.entries()) {
        const image = await decodeImageFile(path);
        const size = options.size ?? { width: evenDimension(image.width), height: evenDimension(image.height) };
        if (!sink) {
          const ffmpeg = out.endsWith('/') ? null : detectFfmpeg();
          if (!ffmpeg && !out.endsWith('/')) {
            log('chromashift: no ffmpeg found — writing a PNG sequence instead');
          }
          sink = ffmpeg
            ? await ffmpegSink(ffmpeg, out, { width: size.width, height: size.height, fps })
            : pngSequenceSink(out.endsWith('/') ? out.slice(0, -1) : `${out.slice(0, -extname(out).length || undefined)}-frames`);
          log(`chromashift: ${sink.describe} · ${size.width}×${size.height} @ ${fps} fps · graph ${options.graph}`);
        }
        const analysis = await session.loadSource(path, image);
        const sourceState = withSourceAnalysis(state, analysis);
        log(`chromashift: [${index + 1}/${images.length}] ${path} · avg luminance ${Math.round(analysis.avgLuminance)} (${analysis.lane})`);
        for await (const { frame } of renderClip(session, sourceState, {
          ...size,
          fps,
          frames: framesPerImage,
          passMode: options.passMode,
          includeTracers: options.includeTracers,
        })) {
          await sink.write(frame);
          rendered += 1;
          if (rendered % fps === 0) {
            const seconds = (performance.now() - started) / 1000;
            log(`chromashift: ${rendered} frames · ${(rendered / seconds).toFixed(1)} fps`);
          }
        }
      }
    } finally {
      await sink?.close();
    }
    const seconds = (performance.now() - started) / 1000;
    log(`chromashift: wrote ${rendered} frames in ${seconds.toFixed(1)} s (${(rendered / seconds).toFixed(1)} fps) → ${out}`);
    return session.runtimeErrors.length === 0 ? 0 : 1;
  });
}

async function commandStill(options: CommonOptions): Promise<number> {
  const { state, images, out } = await prepare(options);
  if (images.length !== 1) throw new UsageError('still renders one image; --image names a folder.');
  const path = images[0]!;
  return withSession(options, async (session) => {
    session.setPassGraph(presetGraphSource(options.graph));
    const image = await decodeImageFile(path);
    const analysis = await session.loadSource(path, image);
    const size = options.size ?? { width: evenDimension(image.width), height: evenDimension(image.height) };
    const frame = await renderStill(session, withSourceAnalysis(state, analysis), {
      ...size,
      fps: options.fps ?? state.ui.videoExportSettings.fps,
      frames: options.frames ?? 30,
      passMode: options.passMode,
      includeTracers: options.includeTracers,
    });
    await writePngFile(out, frame);
    log(`chromashift: wrote ${frame.width}×${frame.height} → ${out}`);
    return session.runtimeErrors.length === 0 ? 0 : 1;
  });
}

async function commandGolden(options: CommonOptions): Promise<number> {
  return withSession(options, async (session) => {
    const fixture = await loadGoldenFixture(session);
    let failures = 0;
    for (const goldenCase of GOLDEN_CASES) {
      const frame = await renderGoldenCase(session, fixture.state(goldenCase.layerCount), goldenCase);
      if (options.update) {
        await writeGolden(goldenCase, frame);
        log(`  ${goldenCase.name.padEnd(12)} written → ${goldenPath(goldenCase)}`);
        continue;
      }
      const difference = compareGolden(await readGolden(goldenCase), frame);
      if (!difference.within) failures += 1;
      log(`  ${goldenCase.name.padEnd(12)} ${difference.within ? 'ok  ' : 'FAIL'} `
        + `${difference.differingPixels} px differ, max channel Δ ${difference.maxChannelDelta}`);
    }
    if (!options.update) {
      log(`chromashift: ${GOLDEN_CASES.length - failures}/${GOLDEN_CASES.length} within tolerance `
        + `(Δ ≤ ${GOLDEN_MAX_CHANNEL_DELTA}, ≤ ${GOLDEN_MAX_DIFFERING_RATIO * 100}% of pixels)`);
    }
    return failures === 0 && session.runtimeErrors.length === 0 ? 0 : 1;
  }, true);
}

/** Run one command. Resolves to the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help' || rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
  try {
    const options = parseCommon(rest);
    switch (command) {
      case 'render':
        return await commandRender(options);
      case 'still':
        return await commandStill(options);
      case 'golden':
        return await commandGolden(options);
      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && 'code' in error)) {
      log(`chromashift: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}
