import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBootstrapRuntimeError, webglContextLostRuntimeError } from '../gpu/gpuErrors';
import { createWebGL2Context, WebGL2ContextLostError, WebGL2UnavailableError } from './webgl2Context';
import { WEBGL2_POWER_PREFERENCE_ATTEMPTS } from '../gpu/gpuOptions';

describe('createWebGL2Context', () => {
  const gl = { isContextLost: () => false } as unknown as WebGL2RenderingContext;
  // Each call is a fresh canvas: the context cache is keyed on it.
  function canvasGranting(grant: (attrs: WebGLContextAttributes) => boolean) {
    const getContext = vi.fn((_type: string, attrs: WebGLContextAttributes) => (grant(attrs) ? gl : null));
    return { canvas: { getContext } as unknown as HTMLCanvasElement, getContext };
  }

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('boots on low-power when the high-performance context is declined', () => {
    const { canvas, getContext } = canvasGranting((attrs) => attrs.powerPreference === 'low-power');
    expect(createWebGL2Context(canvas, { antialias: false })).toBe(gl);
    expect(getContext.mock.calls.map(([, attrs]) => attrs.powerPreference)).toEqual(['high-performance', 'low-power']);
    expect(console.info).toHaveBeenCalledWith(
      '[Chromashift:GPU] WebGL2 context ready',
      { attempt: 2, powerPreference: 'low-power' },
    );
  });

  it('falls through to a preference-less attempt', () => {
    const { canvas, getContext } = canvasGranting((attrs) => !('powerPreference' in attrs));
    expect(createWebGL2Context(canvas, { antialias: false })).toBe(gl);
    expect(getContext).toHaveBeenCalledTimes(3);
  });

  it('throws a distinct error after three nulls, and never touches WebGPU', () => {
    const requestAdapter = vi.fn();
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const { canvas, getContext } = canvasGranting(() => false);
    expect(() => createWebGL2Context(canvas, { antialias: false })).toThrow(WebGL2UnavailableError);
    expect(getContext).toHaveBeenCalledTimes(WEBGL2_POWER_PREFERENCE_ATTEMPTS.length);
    expect(console.error).toHaveBeenCalledOnce();
    expect(requestAdapter).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('reuses the canvas\'s context instead of calling getContext again', () => {
    const { canvas, getContext } = canvasGranting(() => true);
    createWebGL2Context(canvas, { antialias: false });
    expect(createWebGL2Context(canvas, { antialias: false })).toBe(gl);
    expect(getContext).toHaveBeenCalledOnce();
  });

  it('maps a still-lost context to the recoverable overlay', () => {
    const lostGl = { isContextLost: () => true } as unknown as WebGL2RenderingContext;
    const canvas = { getContext: vi.fn(() => lostGl) } as unknown as HTMLCanvasElement;
    createWebGL2Context(canvas, { antialias: false });
    let thrown: unknown;
    try {
      createWebGL2Context(canvas, { antialias: false });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WebGL2ContextLostError);
    expect(toBootstrapRuntimeError(thrown)).toEqual(webglContextLostRuntimeError());
    expect(webglContextLostRuntimeError()).toMatchObject({ kind: 'device-lost', recoverable: true });
  });
});
