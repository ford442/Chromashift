export const ROTATION_VERTEX_SOURCE = `#version 300 es
precision highp float;

const vec2 POS[6] = vec2[6](
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
  vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
);
const vec2 UV[6] = vec2[6](
  vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(0.0, 0.0),
  vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(1.0, 0.0)
);

uniform float u_angleRad;
uniform float u_flipX;
uniform float u_flipY;
uniform float u_aspect;

out vec2 v_uv;
out vec2 v_baseUv;

void main() {
  vec2 uv = UV[gl_VertexID];
  v_baseUv = uv;
  uv.x = mix(uv.x, 1.0 - uv.x, u_flipX);
  uv.y = mix(uv.y, 1.0 - uv.y, u_flipY);
  float c = cos(u_angleRad);
  float s = sin(u_angleRad);
  vec2 p = uv - vec2(0.5);
  vec2 aspectCorrection = vec2(1.0, u_aspect);
  vec2 pa = p * aspectCorrection;
  vec2 rotated = vec2(pa.x * c - pa.y * s, pa.x * s + pa.y * c);
  v_uv = rotated / aspectCorrection + vec2(0.5);
  gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
}
`;

export const PASSTHROUGH_VERTEX_SOURCE = `#version 300 es
precision highp float;

const vec2 POS[6] = vec2[6](
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
  vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
);
const vec2 UV[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
);

out vec2 v_uv;

void main() {
  v_uv = UV[gl_VertexID];
  gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
}
`;
