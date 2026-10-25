/**
 * A recording `WebGL2RenderingContext` for executor tests — the WebGL twin of
 * `fakeDevice.ts`. It links anything (unless told to reject a source), keeps
 * the GL state the executor relies on (bound framebuffer, texture units,
 * program, sampler uniforms) and records every draw: its target, its program's
 * fragment source and the texture each sampler reads.
 *
 * A draw that samples the texture it renders into is a WebGL feedback loop —
 * an error on a real context — so the fake throws on one.
 */

export interface FakeTexture {
  readonly id: number;
  width: number;
  height: number;
  deleted: boolean;
}

interface FakeFramebuffer {
  readonly id: number;
  texture: FakeTexture | null;
}

interface FakeShader {
  readonly type: number;
  source: string;
}

interface FakeProgram {
  readonly id: number;
  readonly shaders: FakeShader[];
  readonly uniformNames: string[];
  readonly samplerNames: Set<string>;
  readonly values: Map<string, number>;
}

export interface FakeDraw {
  /** The texture drawn into, or `null` for the default framebuffer. */
  target: FakeTexture | null;
  fragment: string;
  /** Sampler uniform → the texture its unit had bound at draw time. */
  samplers: Record<string, FakeTexture | null>;
  /** Every scalar uniform the program held at draw time, by name. */
  uniforms: Record<string, number>;
  viewport: [number, number, number, number];
}

export interface FakeWebGl {
  gl: WebGL2RenderingContext;
  draws: FakeDraw[];
  textures: FakeTexture[];
  programsLinked: () => number;
  /** Fail to compile any shader whose source this matches. */
  rejectShader: (test: ((source: string) => boolean) | null) => void;
}

const UNIFORM = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*;/g;

export function createFakeWebGl(): FakeWebGl {
  let nextId = 1;
  const textures: FakeTexture[] = [];
  const draws: FakeDraw[] = [];
  let linked = 0;
  let reject: ((source: string) => boolean) | null = null;

  let activeUnit = 0;
  const units = new Map<number, FakeTexture | null>();
  let framebuffer: FakeFramebuffer | null = null;
  let program: FakeProgram | null = null;
  let viewport: [number, number, number, number] = [0, 0, 0, 0];

  const constants: Record<string, number> = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ACTIVE_UNIFORMS: 5,
    FRAMEBUFFER_COMPLETE: 6,
    TEXTURE0: 1000,
  };

  const impl: Record<string, unknown> = {
    createShader: (type: number): FakeShader => ({ type, source: '' }),
    shaderSource: (shader: FakeShader, source: string) => { shader.source = source; },
    getShaderParameter: (shader: FakeShader) => !(reject?.(shader.source) ?? false),
    getShaderInfoLog: () => 'ERROR: 0:1: rejected by the fake context',
    createProgram: (): FakeProgram => ({
      id: nextId++, shaders: [], uniformNames: [], samplerNames: new Set(), values: new Map(),
    }),
    attachShader: (p: FakeProgram, shader: FakeShader) => { p.shaders.push(shader); },
    linkProgram: (p: FakeProgram) => {
      for (const shader of p.shaders) {
        for (const [, type, name] of shader.source.matchAll(UNIFORM)) {
          p.uniformNames.push(name);
          if (type.startsWith('sampler')) p.samplerNames.add(name);
        }
      }
      linked += 1;
    },
    getProgramParameter: (p: FakeProgram, parameter: number) =>
      (parameter === constants.ACTIVE_UNIFORMS ? p.uniformNames.length : true),
    getActiveUniform: (p: FakeProgram, index: number) => ({ name: p.uniformNames[index] }),
    getUniformLocation: (p: FakeProgram, name: string) =>
      (p.uniformNames.includes(name) ? { program: p, name } : null),
    useProgram: (p: FakeProgram) => { program = p; },
    uniform1f: (location: { program: FakeProgram; name: string }, value: number) => {
      location.program.values.set(location.name, value);
    },
    uniform1i: (location: { program: FakeProgram; name: string }, value: number) => {
      location.program.values.set(location.name, value);
    },
    activeTexture: (unit: number) => { activeUnit = unit - constants.TEXTURE0; },
    createTexture: (): FakeTexture => {
      const texture = { id: nextId++, width: 0, height: 0, deleted: false };
      textures.push(texture);
      return texture;
    },
    bindTexture: (_target: number, texture: FakeTexture | null) => { units.set(activeUnit, texture); },
    texImage2D: (_target: number, _level: number, _format: number, width: number, height: number) => {
      const bound = units.get(activeUnit);
      if (bound) {
        bound.width = width;
        bound.height = height;
      }
    },
    deleteTexture: (texture: FakeTexture) => { texture.deleted = true; },
    createFramebuffer: (): FakeFramebuffer => ({ id: nextId++, texture: null }),
    bindFramebuffer: (_target: number, fb: FakeFramebuffer | null) => { framebuffer = fb; },
    framebufferTexture2D: (_t: number, _a: number, _tt: number, texture: FakeTexture) => {
      if (framebuffer) framebuffer.texture = texture;
    },
    checkFramebufferStatus: () => constants.FRAMEBUFFER_COMPLETE,
    viewport: (x: number, y: number, w: number, h: number) => { viewport = [x, y, w, h]; },
    drawArrays: () => {
      if (!program) throw new Error('drawArrays with no program');
      const target = framebuffer?.texture ?? null;
      const samplers: Record<string, FakeTexture | null> = {};
      for (const name of program.samplerNames) {
        const texture = units.get(program.values.get(name) ?? 0) ?? null;
        samplers[name] = texture;
        if (texture && texture === target) {
          throw new Error(`Feedback loop: ${name} samples the texture this pass renders into.`);
        }
      }
      const fragment = program.shaders.find((s) => s.type === constants.FRAGMENT_SHADER)?.source ?? '';
      draws.push({
        target,
        fragment,
        samplers,
        uniforms: Object.fromEntries([...program.values].filter(([name]) => !program!.samplerNames.has(name))),
        viewport: [...viewport],
      });
    },
  };

  const gl = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (prop in constants) return constants[prop];
      // Any other enum is just a distinct number; any other call is a no-op.
      if (/^[A-Z0-9_]+$/.test(prop)) return 0x10000 + prop.length;
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;

  return {
    gl,
    draws,
    textures,
    programsLinked: () => linked,
    rejectShader: (test) => { reject = test; },
  };
}
