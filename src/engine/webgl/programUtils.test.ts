import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createProgram, declaredUniforms, uniform1f } from './programUtils';
import * as webglShaders from './shaders';

const VERTEX = `#version 300 es
uniform mat3 u_rotation;
void main() { gl_Position = vec4(u_rotation[0], 1.0); }`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform highp float u_gain;
uniform float u_unused;
uniform sampler2D u_layers[3];
out vec4 o;
void main() { o = vec4(u_gain) + texture(u_layers[0], vec2(0.0)); }`;

/** A WebGL2 context that links anything and reports `u_gain`, `u_rotation` and `u_layers[0]` active. */
function fakeGl() {
  const active = ['u_rotation', 'u_gain', 'u_layers[0]'];
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ACTIVE_UNIFORMS: 5,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    deleteShader: () => {},
    getProgramParameter: (_program: unknown, parameter: number) => (parameter === 5 ? active.length : true),
    getActiveUniform: (_program: unknown, index: number) => ({ name: active[index] }),
    getUniformLocation: vi.fn((_program: unknown, name: string) => (active.includes(name) ? { name } : null)),
    uniform1f: vi.fn(),
  };
  return gl;
}

describe('programUtils uniforms', () => {
  it('looks a location up once, including a null one', () => {
    const gl = fakeGl();
    const info = createProgram(gl as unknown as WebGL2RenderingContext, VERTEX, FRAGMENT);
    for (let frame = 0; frame < 3; frame += 1) {
      uniform1f(gl as unknown as WebGL2RenderingContext, info, 'u_gain', 1);
      uniform1f(gl as unknown as WebGL2RenderingContext, info, 'u_unused', 1);
    }
    expect(gl.getUniformLocation).toHaveBeenCalledTimes(2);
    expect(gl.uniform1f).toHaveBeenCalledTimes(3); // only the active one is set
  });

  it('accepts a declared uniform the compiler optimised out', () => {
    const gl = fakeGl();
    const info = createProgram(gl as unknown as WebGL2RenderingContext, VERTEX, FRAGMENT);
    expect(() => uniform1f(gl as unknown as WebGL2RenderingContext, info, 'u_unused', 0)).not.toThrow();
  });

  it('throws in development on a name the program does not declare', () => {
    const gl = fakeGl();
    const info = createProgram(gl as unknown as WebGL2RenderingContext, VERTEX, FRAGMENT);
    expect(() => uniform1f(gl as unknown as WebGL2RenderingContext, info, 'u_gian', 0))
      .toThrow('WebGL uniform "u_gian" is not declared by this program');
  });

  it('parses declarations with precision qualifiers and arrays', () => {
    expect(declaredUniforms(FRAGMENT)).toEqual(['u_gain', 'u_unused', 'u_layers']);
  });
});

describe('the WebGL passes', () => {
  it('set only uniforms some WebGL shader declares', () => {
    const declared = new Set(Object.values(webglShaders).flatMap(declaredUniforms));
    const dir = __dirname;
    const used = readdirSync(dir)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .flatMap((file) => [...readFileSync(join(dir, file), 'utf8')
        .matchAll(/(?:uniform1[fi]|bindTexture)\(\s*gl,\s*[\w.]+,\s*'(\w+)'/g)]
        .map((match) => `${file}: ${match[1]}`));
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((entry) => !declared.has(entry.split(': ')[1]))).toEqual([]);
  });
});
