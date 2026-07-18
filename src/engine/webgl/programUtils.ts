export interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
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
  return { program, uniforms: new Map() };
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
  if (!info.uniforms.has(name)) {
    const location = gl.getUniformLocation(info.program, name);
    if (location) info.uniforms.set(name, location);
    return location;
  }
  return info.uniforms.get(name) ?? null;
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
