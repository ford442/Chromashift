import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getWebGL2ContextAttributes,
  resolveWebGL2Desynchronized,
  resolveWebGL2PreserveDrawingBuffer,
  webglInternalFormatNote,
  RENDERER_CANVAS_OPTIONS_MATRIX,
} from './gpuOptions';

describe('getWebGL2ContextAttributes', () => {
  it('never multisamples the default framebuffer — MSAA is the band layers\' renderbuffer', () => {
    expect(getWebGL2ContextAttributes({ antialias: true }).antialias).toBe(false);
    expect(getWebGL2ContextAttributes({ antialias: false }).antialias).toBe(false);
  });

  it('sets the attempt\'s powerPreference, and omits the key for the preference-less attempt', () => {
    expect(getWebGL2ContextAttributes({ antialias: false }, 'low-power').powerPreference).toBe('low-power');
    expect('powerPreference' in getWebGL2ContextAttributes({ antialias: false }, null)).toBe(false);
  });

  it('never asks for desynchronized alongside preserveDrawingBuffer', () => {
    expect(getWebGL2ContextAttributes({ antialias: false }).desynchronized).toBe(false);
    expect(getWebGL2ContextAttributes({ antialias: false, desynchronized: true }).desynchronized).toBe(true);
    expect(getWebGL2ContextAttributes({
      antialias: false,
      desynchronized: true,
      preserveDrawingBuffer: true,
    }).desynchronized).toBe(false);
  });

  it('matches the options matrix documented in docs/gpu-bootstrap.md', () => {
    const attrs = getWebGL2ContextAttributes({ antialias: true });
    const m = RENDERER_CANVAS_OPTIONS_MATRIX.webgl2;
    expect(attrs).toMatchObject({
      alpha: m.alpha,
      antialias: m.antialias,
      preserveDrawingBuffer: m.preserveDrawingBuffer,
      desynchronized: m.desynchronized,
      depth: m.depth,
      stencil: m.stencil,
      premultipliedAlpha: m.premultipliedAlpha,
    });
    const doc = readFileSync(resolve(__dirname, '../../../docs/gpu-bootstrap.md'), 'utf8');
    const row = (name: string) => doc.split('\n').find((line) => line.startsWith(`| ${name} |`)) ?? '';
    expect(row('Alpha')).toContain('`alpha: false`');
    expect(row('Antialias')).toContain('`antialias: false`');
    expect(row('Preserve buffer')).toContain('`preserveDrawingBuffer: false`');
    expect(row('Desynchronized')).toContain('`desynchronized: false`');
    expect(row('Depth / stencil')).toContain('`depth: false`, `stencil: false`');
    expect(row('Premultiplied alpha')).toContain('`premultipliedAlpha: false`');
    expect(row('Power')).toContain('`high-performance` → `low-power` → `powerPreference` omitted');
  });
});

describe('resolveWebGL2Desynchronized', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is off by default', () => {
    vi.stubGlobal('window', { location: { search: '' } });
    expect(resolveWebGL2Desynchronized(false)).toBe(false);
  });

  it('honours ?desynchronized=1 when preserve-drawing-buffer is off', () => {
    vi.stubGlobal('window', { location: { search: '?desynchronized=1' } });
    expect(resolveWebGL2Desynchronized(false)).toBe(true);
  });

  it('ignores ?desynchronized=1 when preserve-drawing-buffer resolved on', () => {
    vi.stubGlobal('window', { location: { search: '?desynchronized=1' } });
    vi.stubGlobal('navigator', { webdriver: true });
    const preserve = resolveWebGL2PreserveDrawingBuffer();
    expect(preserve).toBe(true);
    expect(resolveWebGL2Desynchronized(preserve)).toBe(false);
  });
});

describe('webglInternalFormatNote', () => {
  it('notes 8-bit targets and is silent for half-float ones', () => {
    expect(webglInternalFormatNote('rgba8')).toMatch(/rgba8.*clip/);
    expect(webglInternalFormatNote('rgba16f')).toBeNull();
  });
});

describe('getWebGL2ContextAttributes defaults', () => {

  it('keeps alpha disabled and preserveDrawingBuffer off by default', () => {
    const attrs = getWebGL2ContextAttributes({ antialias: false });
    expect(attrs.alpha).toBe(false);
    // The live diagnostic session never reads the canvas back; preserving it
    // costs a copy per frame. Screenshot / readback callers opt in below.
    expect(attrs.preserveDrawingBuffer).toBe(false);
    expect(attrs.powerPreference).toBe('high-performance');
  });

  it('allows screenshot/readback callers to opt into preserveDrawingBuffer', () => {
    const attrs = getWebGL2ContextAttributes({
      antialias: false,
      preserveDrawingBuffer: true,
      xrCompatible: true,
    });
    expect(attrs.preserveDrawingBuffer).toBe(true);
    expect(attrs.xrCompatible).toBe(true);
  });
});

describe('resolveWebGL2PreserveDrawingBuffer', () => {
  // The suite runs in the `node` environment, so window/navigator are stubbed
  // rather than mutated.
  function setEnvironment(options: { search?: string; webdriver?: boolean }): void {
    vi.stubGlobal('window', { location: { search: options.search ?? '' } });
    vi.stubGlobal('navigator', { webdriver: options.webdriver ?? false });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is off for a normal live session', () => {
    setEnvironment({});
    expect(resolveWebGL2PreserveDrawingBuffer()).toBe(false);
  });

  it('is on under automation so Playwright captures a drawn canvas', () => {
    setEnvironment({ webdriver: true });
    expect(resolveWebGL2PreserveDrawingBuffer()).toBe(true);
  });

  it('lets the URL param force it on in a normal tab', () => {
    setEnvironment({ search: '?preserve_drawing_buffer=1' });
    expect(resolveWebGL2PreserveDrawingBuffer()).toBe(true);
    setEnvironment({ search: '?preserve_drawing_buffer' });
    expect(resolveWebGL2PreserveDrawingBuffer()).toBe(true);
  });

  it('lets the URL param force it off under automation', () => {
    setEnvironment({ search: '?preserve_drawing_buffer=0', webdriver: true });
    expect(resolveWebGL2PreserveDrawingBuffer()).toBe(false);
  });
});
