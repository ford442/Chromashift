export interface ProgramInfo {
  program: WebGLProgram;
  /**
   * Location per uniform name, looked up once. `null` is cached too: a uniform
   * the compiler optimised out has no location, and asking the driver again
   * every frame is a wasted round trip.
   */
  uniforms: Map<string, WebGLUniformLocation | null>;
  /**
   * Every name the program knows: its active uniforms plus everything either
   * source declares `uniform` (the compiler may drop a declared one). A name
   * outside this set is a typo, not an optimised-out uniform.
   */
  knownUniforms: ReadonlySet<string>;
}

/** `uniform [precision] type name[N];` declarations, by name. */
export function declaredUniforms(source: string): string[] {
  const declaration = /\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g;
  return [...source.matchAll(declaration)].map((match) => match[1]);
}

function activeUniforms(gl: WebGL2RenderingContext, program: WebGLProgram): string[] {
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = gl.getActiveUniform(program, i)?.name;
    // Arrays are reported as `u_x[0]`; `u_x` addresses the same element.
    if (name) names.push(name, name.replace(/\[0\]$/, ''));
  }
  return names;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): ProgramInfo {
  const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create WebGL program.');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown link error';
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${log}`);
  }
  return {
    program,
    uniforms: new Map(),
    knownUniforms: new Set([
      ...activeUniforms(gl, program),
      ...declaredUniforms(vertexSource),
      ...declaredUniforms(fragmentSource),
    ]),
  };
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create WebGL shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown compile error';
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${log}`);
  }
  return shader;
}

export function activateProgram(gl: WebGL2RenderingContext, info: ProgramInfo): void {
  gl.useProgram(info.program);
}

function uniformLocation(
  gl: WebGL2RenderingContext,
  info: ProgramInfo,
  name: string,
): WebGLUniformLocation | null {
  const cached = info.uniforms.get(name);
  if (cached !== undefined) return cached;
  // A misspelled uniform used to be a silent no-op: `getUniformLocation`
  // returns null and the setter skips it. Fail loudly in development instead.
  if (import.meta.env.DEV && !info.knownUniforms.has(name)) {
    throw new Error(
      `WebGL uniform "${name}" is not declared by this program `
      + `(known: ${[...info.knownUniforms].sort().join(', ')})`,
    );
  }
  const location = gl.getUniformLocation(info.program, name);
  info.uniforms.set(name, location);
  return location;
}

export function uniform1f(
  gl: WebGL2RenderingContext,
  info: ProgramInfo,
  name: string,
  value: number,
): void {
  const location = uniformLocation(gl, info, name);
  if (location) gl.uniform1f(location, value);
}

export function uniform1i(
  gl: WebGL2RenderingContext,
  info: ProgramInfo,
  name: string,
  value: number,
): void {
  const location = uniformLocation(gl, info, name);
  if (location) gl.uniform1i(location, value);
}

export function bindTexture(
  gl: WebGL2RenderingContext,
  info: ProgramInfo,
  name: string,
  unit: number,
  texture: WebGLTexture,
): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  uniform1i(gl, info, name, unit);
}

export function destroyProgram(gl: WebGL2RenderingContext, info: ProgramInfo): void {
  gl.deleteProgram(info.program);
}
