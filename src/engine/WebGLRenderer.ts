import { MAIN_VIEW_MODES } from './viewModes';
import type { CollisionStats, RendererState } from './WebGPURenderer';
import type { ChromashiftRenderer, ExportTracerOptions, ExportTracerResult, RenderTiming } from './RendererTypes';
import type { WebGLImageTexture } from './WebGLTextureManager';

const PREVIEW_SIZE = 128;
const DIAGNOSTIC_SIZE = 64;

const VERTEX_SOURCE = `#version 300 es
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

const PASSTHROUGH_VERTEX_SOURCE = `#version 300 es
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

const LAYER_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_source;
uniform int u_layerIndex;
uniform float u_avgLuminance;
uniform float u_layerOpacity;
uniform float u_colorMode;
uniform float u_sobelEnabled;
uniform float u_softCropEnabled;
uniform int u_debugMode;

in vec2 v_uv;
in vec2 v_baseUv;
out vec4 outColor;

float luminanceAt(vec2 uv) {
  vec3 c = texture(u_source, uv).rgb;
  return dot(c, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
}

float boostedLuminance(vec2 uv, float baseLum) {
  if (u_sobelEnabled < 0.5) return baseLum;
  vec2 texel = 1.0 / vec2(textureSize(u_source, 0));
  float tl = luminanceAt(uv + texel * vec2(-1.0, -1.0));
  float tc = luminanceAt(uv + texel * vec2(0.0, -1.0));
  float tr = luminanceAt(uv + texel * vec2(1.0, -1.0));
  float ml = luminanceAt(uv + texel * vec2(-1.0, 0.0));
  float mr = luminanceAt(uv + texel * vec2(1.0, 0.0));
  float bl = luminanceAt(uv + texel * vec2(-1.0, 1.0));
  float bc = luminanceAt(uv + texel * vec2(0.0, 1.0));
  float br = luminanceAt(uv + texel * vec2(1.0, 1.0));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  return clamp(baseLum + 16.0 * length(vec2(gx, gy)), 0.0, 255.0);
}

vec3 hsl2rgb(float h, float s, float l) {
  vec3 k = vec3(0.0, 8.0, 4.0) + h * 12.0;
  vec3 rgb = clamp(abs(mod(k, 6.0) - 3.0) - 1.0, 0.0, 1.0);
  float a = s * min(l, 1.0 - l);
  return l - a + a * rgb;
}

vec3 bandGradient(float value, float low, float high, float hueLow, float hueHigh, float sat, float lumLow, float lumHigh) {
  float t = clamp((value - low) / max(0.0001, high - low), 0.0, 1.0);
  return hsl2rgb(mix(hueLow, hueHigh, t) / 360.0, sat, mix(lumLow, lumHigh, t));
}

float softThreshold(float v, float edge, float width) {
  return smoothstep(edge - width, edge + width, v);
}

vec4 cropColor(int layer, float bandLum, float soft, float nonAlpha, float darkAlpha) {
  float tw = 2.2;
  if (layer == 0) {
    vec4 grey = vec4(0.753, 0.753, 0.753, nonAlpha);
    vec4 orange = vec4(1.0, 0.627, 0.0, nonAlpha);
    vec4 red = vec4(1.0, 0.0, 0.0, nonAlpha);
    vec4 dark = vec4(0.0, 0.0, 0.0, darkAlpha);
    if (soft < 0.5) {
      if (bandLum >= 229.0) return grey;
      if (bandLum >= 209.0) return orange;
      if (bandLum >= 190.0) return red;
      return dark;
    }
    if (bandLum >= 229.0 - tw) return mix(orange, grey, softThreshold(bandLum, 229.0, tw));
    if (bandLum >= 209.0 - tw) return mix(red, orange, softThreshold(bandLum, 209.0, tw));
    if (bandLum >= 190.0 - tw) return mix(dark, red, softThreshold(bandLum, 190.0, tw));
    return dark;
  }
  if (layer == 1) {
    vec4 violet = vec4(0.502, 0.0, 0.502, nonAlpha);
    vec4 blue = vec4(0.0, 0.0, 0.545, nonAlpha);
    vec4 border = vec4(0.0, 0.0, 1.0, nonAlpha);
    vec4 dark = vec4(0.0, 0.0, 0.0, darkAlpha);
    if (soft < 0.5) {
      if (bandLum >= 177.0 && bandLum < 190.0) return violet;
      if (bandLum >= 161.0 && bandLum < 177.0) return blue;
      if (bandLum >= 158.0 && bandLum < 161.0) return border;
      return dark;
    }
    if (bandLum >= 177.0 - tw) return mix(mix(blue, violet, softThreshold(bandLum, 177.0, tw)), dark, softThreshold(bandLum, 190.0, tw));
    if (bandLum >= 161.0 - tw) return mix(border, blue, softThreshold(bandLum, 177.0, tw));
    if (bandLum >= 158.0 - tw) return mix(dark, border, softThreshold(bandLum, 161.0, tw));
    return dark;
  }
  vec4 green = vec4(0.0, 0.502, 0.0, nonAlpha);
  vec4 yellow = vec4(0.502, 1.0, 0.0, nonAlpha);
  vec4 border = vec4(1.0, 1.0, 0.0, nonAlpha);
  vec4 dark = vec4(0.0, 0.0, 0.0, darkAlpha);
  if (soft < 0.5) {
    if (bandLum >= 145.0 && bandLum < 158.0) return green;
    if (bandLum >= 128.0 && bandLum < 145.0) return yellow;
    if (bandLum >= 125.0 && bandLum < 128.0) return border;
    return dark;
  }
  if (bandLum >= 145.0 - tw) return mix(mix(yellow, green, softThreshold(bandLum, 145.0, tw)), dark, softThreshold(bandLum, 158.0, tw));
  if (bandLum >= 128.0 - tw) return mix(border, yellow, softThreshold(bandLum, 145.0, tw));
  if (bandLum >= 125.0 - tw) return mix(dark, border, softThreshold(bandLum, 128.0, tw));
  return dark;
}

vec4 fixedLayerColor(int layer, float lum) {
  float diff = (u_avgLuminance / 255.0) * 32.0;
  float lightDark = 128.0 + abs(u_avgLuminance - 128.0) / 2.0;
  float rgb = lum + lightDark / 2.0;
  float grey = u_avgLuminance;
  float gDark = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
  if (layer == 0) {
    if (rgb > 229.0) {
      float g = clamp((grey + (rgb - 229.0)) / 255.0, 0.0, 1.0);
      return vec4(g, g, g, 1.0);
    }
    if (rgb > 209.0) return vec4(1.0, (128.0 - diff) / 255.0, 0.0, 1.0);
    if (rgb > 193.0) return vec4((255.0 - diff) / 255.0, 0.0, 0.0, 1.0);
    if (rgb > 190.0) return vec4(1.0, 0.0, 0.0, 1.0);
    if (rgb <= 126.0) return vec4(gDark, gDark, gDark, 1.0);
    return vec4(0.0);
  }
  if (layer == 1) {
    if (rgb > 177.0 && rgb <= 190.0) return vec4((128.0 - diff) / 255.0, 0.0, 1.0, 1.0);
    if (rgb > 161.0 && rgb <= 177.0) return vec4(0.0, 0.0, (255.0 - diff) / 255.0, 1.0);
    if (rgb > 158.0 && rgb <= 161.0) return vec4(0.0, 0.0, 1.0, 1.0);
    if (rgb <= 126.0) return vec4(gDark, gDark, gDark, 1.0);
    return vec4(0.0);
  }
  if (rgb > 145.0 && rgb <= 158.0) return vec4(0.0, (255.0 - diff) / 255.0, 0.0, 1.0);
  if (rgb > 128.0 && rgb <= 145.0) return vec4(1.0, (255.0 - diff) / 255.0, 0.0, 1.0);
  if (rgb > 125.0 && rgb <= 128.0) return vec4(1.0, 1.0, 0.0, 1.0);
  if (rgb <= 126.0) return vec4(gDark, gDark, gDark, 1.0);
  return vec4(0.0);
}

void main() {
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  vec4 sampleColor = texture(u_source, v_uv);
  float rawLum = dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722)) * 255.0;
  float lum = boostedLuminance(v_uv, rawLum);

  if (u_debugMode == 1) {
    float l = lum / 255.0;
    outColor = vec4(l, l, l, 1.0);
    return;
  }
  if (u_debugMode == 2) {
    vec2 grid = step(vec2(0.965), fract(v_uv * 12.0));
    float line = max(grid.x, grid.y);
    outColor = vec4(v_uv, line, 1.0);
    return;
  }

  vec4 result = vec4(0.0);
  if (u_colorMode == 1.0) {
    if (u_layerIndex == 0) {
      if (lum > 229.0) result = vec4(bandGradient(lum, 229.0, 255.0, 45.0, 60.0, 0.3, 0.80, 1.0), 1.0);
      else if (lum > 209.0) result = vec4(bandGradient(lum, 209.0, 229.0, 10.0, 40.0, 1.0, 0.50, 0.65), 1.0);
      else if (lum > 190.0) result = vec4(bandGradient(lum, 190.0, 209.0, 0.0, 10.0, 1.0, 0.40, 0.55), 1.0);
    } else if (u_layerIndex == 1) {
      if (lum > 177.0 && lum <= 190.0) result = vec4(bandGradient(lum, 177.0, 190.0, 255.0, 290.0, 1.0, 0.40, 0.55), 1.0);
      else if (lum > 158.0 && lum <= 177.0) result = vec4(bandGradient(lum, 158.0, 177.0, 220.0, 255.0, 1.0, 0.38, 0.50), 1.0);
    } else {
      if (lum > 145.0 && lum <= 158.0) result = vec4(bandGradient(lum, 145.0, 158.0, 90.0, 130.0, 1.0, 0.38, 0.50), 1.0);
      else if (lum > 125.0 && lum <= 145.0) result = vec4(bandGradient(lum, 125.0, 145.0, 50.0, 90.0, 1.0, 0.40, 0.52), 1.0);
    }
  } else if (u_colorMode >= 1.5) {
    float adjusted = lum + (128.0 + abs(u_avgLuminance - 128.0) * 0.5) * 0.5;
    bool isNunif2 = u_colorMode > 2.5;
    float bandLum = isNunif2 ? adjusted : lum;
    float nonAlpha = isNunif2 && u_layerIndex == 0 ? 0.5 : isNunif2 ? 0.777 : 1.0;
    float darkAlpha = isNunif2 ? 0.1 : 0.0;
    result = cropColor(u_layerIndex, bandLum, u_softCropEnabled, nonAlpha, darkAlpha);
  } else {
    result = fixedLayerColor(u_layerIndex, lum);
  }

  if (u_debugMode == 3) {
    outColor = result.a > 0.0 ? vec4(result.rgb, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  outColor = vec4(result.rgb, result.a * u_layerOpacity);
}
`;

const PERSISTENCE_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_layer0;
uniform sampler2D u_layer1;
uniform sampler2D u_layer2;
uniform sampler2D u_previous;
uniform float u_decay;
uniform float u_stampBoost;
uniform int u_tracerMode;
uniform int u_peakMode;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec4 c0 = texture(u_layer0, v_uv);
  vec4 c1 = texture(u_layer1, v_uv);
  vec4 c2 = texture(u_layer2, v_uv);
  vec4 prev = texture(u_previous, v_uv);
  float count = step(0.01, c0.a) + step(0.01, c1.a) + step(0.01, c2.a);
  // Peak mode discards the decayed history so only fresh collision stamps show,
  // mirroring the WebGPU persistence pass (peakMode -> decayed = 0).
  vec4 decayed = u_peakMode == 1 ? vec4(0.0) : vec4(prev.rgb * u_decay, prev.a * u_decay);
  if (count < 1.5) {
    outColor = decayed;
    return;
  }
  vec3 combined = (c0.rgb * step(0.01, c0.a) + c1.rgb * step(0.01, c1.a) + c2.rgb * step(0.01, c2.a)) / count;
  float lum = dot(combined, vec3(0.2126, 0.7152, 0.0722));
  vec3 stamped = u_tracerMode == 1 ? vec3(min(lum * u_stampBoost, 1.0)) : min(combined * u_stampBoost, vec3(1.0));
  vec4 fresh = vec4(stamped, count > 2.5 ? 1.0 : 0.72);
  outColor = max(decayed, fresh);
}
`;

const COMPOSITOR_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_layer0;
uniform sampler2D u_layer1;
uniform sampler2D u_layer2;
uniform sampler2D u_tracerBelow;
uniform sampler2D u_tracerAbove;
uniform float u_layerOpacity0;
uniform float u_layerOpacity1;
uniform float u_layerOpacity2;
uniform float u_tracerBelowOpacity;
uniform float u_tracerAboveOpacity;
uniform int u_layerBlendMode;
uniform int u_tracerBlendMode;
uniform int u_outputMode;
uniform int u_mainViewMode;
uniform int u_diagnosticsMode;
uniform float u_diagnosticsOpacity;
uniform int u_viewportQuarterZoom;
uniform int u_viewportHalfOverlay;
uniform float u_halfOverlayAlpha;

in vec2 v_uv;
out vec4 outColor;

vec4 scaleAlpha(vec4 c, float opacity) {
  return vec4(c.rgb, c.a * opacity);
}

vec2 viewportSampleUV(vec2 uv) {
  if (u_viewportQuarterZoom == 0) {
    return uv;
  }
  return vec2(uv.x * 0.5, uv.y * 0.5 + 0.5);
}

vec3 blendRgb(vec3 d, vec3 s, int mode) {
  if (mode == 1) return min(d + s, vec3(1.0));
  if (mode == 2) return max(d - s, vec3(0.0));
  if (mode == 3) return d * s;
  if (mode == 4) return 1.0 - (1.0 - d) * (1.0 - s);
  if (mode == 5) return max(d, s);
  if (mode == 6) return min(d, s);
  if (mode == 10) return abs(d - s);
  if (mode == 11) return d + s - 2.0 * d * s;
  return s;
}

vec4 blendOver(vec4 dst, vec4 src, int mode) {
  if (src.a <= 0.0) return dst;
  if (dst.a <= 0.0) return src;
  vec3 blended = blendRgb(dst.rgb, src.rgb, mode);
  float outA = src.a + dst.a * (1.0 - src.a);
  vec3 rgb = (
    src.rgb * src.a * (1.0 - dst.a) +
    dst.rgb * dst.a * (1.0 - src.a) +
    blended * src.a * dst.a
  ) / max(outA, 0.0001);
  return vec4(clamp(rgb, 0.0, 1.0), outA);
}

vec4 collisionColor(vec4 c0, vec4 c1, vec4 c2) {
  float count = step(0.01, c0.a) + step(0.01, c1.a) + step(0.01, c2.a);
  if (count < 1.5) return vec4(0.0);
  return count > 2.5 ? vec4(1.0, 0.85, 0.1, 1.0) : vec4(0.2, 0.8, 1.0, 0.8);
}

vec4 compositeProcessed(vec2 sampleUV) {
  vec4 c0 = scaleAlpha(texture(u_layer0, sampleUV), u_layerOpacity0);
  vec4 c1 = scaleAlpha(texture(u_layer1, sampleUV), u_layerOpacity1);
  vec4 c2 = scaleAlpha(texture(u_layer2, sampleUV), u_layerOpacity2);
  vec4 below = scaleAlpha(texture(u_tracerBelow, sampleUV), u_tracerBelowOpacity);
  vec4 above = scaleAlpha(texture(u_tracerAbove, sampleUV), u_tracerAboveOpacity);
  vec4 live = blendOver(blendOver(c0, c1, u_layerBlendMode), c2, u_layerBlendMode);
  vec4 tracer = blendOver(below, above, u_tracerBlendMode);
  vec4 finalColor = u_outputMode == 2 ? tracer : u_outputMode == 1 ? blendOver(tracer, live, u_layerBlendMode) : blendOver(live, tracer, u_tracerBlendMode);
  if (u_diagnosticsMode == 1) {
    finalColor = blendOver(finalColor, scaleAlpha(collisionColor(c0, c1, c2), u_diagnosticsOpacity), 4);
  }
  return vec4(finalColor.rgb, 1.0);
}

void main() {
  if (u_mainViewMode == 1) {
    vec4 below = scaleAlpha(texture(u_tracerBelow, v_uv), u_tracerBelowOpacity);
    vec4 above = scaleAlpha(texture(u_tracerAbove, v_uv), u_tracerAboveOpacity);
    outColor = vec4(blendOver(below, above, u_tracerBlendMode).rgb, 1.0);
    return;
  }
  if (u_mainViewMode == 3) {
    outColor = vec4(texture(u_layer0, v_uv).rgb, 1.0);
    return;
  }
  if (u_mainViewMode == 4) {
    outColor = vec4(texture(u_layer1, v_uv).rgb, 1.0);
    return;
  }
  if (u_mainViewMode == 5) {
    outColor = vec4(texture(u_layer2, v_uv).rgb, 1.0);
    return;
  }
  if (u_mainViewMode == 6 || u_mainViewMode == 11) {
    vec4 c0 = scaleAlpha(texture(u_layer0, v_uv), u_layerOpacity0);
    vec4 c1 = scaleAlpha(texture(u_layer1, v_uv), u_layerOpacity1);
    vec4 c2 = scaleAlpha(texture(u_layer2, v_uv), u_layerOpacity2);
    outColor = vec4(collisionColor(c0, c1, c2).rgb, 1.0);
    return;
  }

  if (u_viewportHalfOverlay == 1) {
    if (v_uv.y > 0.5) {
      outColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    vec2 topUV = vec2(v_uv.x, v_uv.y);
    vec2 bottomUV = vec2(v_uv.x, v_uv.y + 0.5);
    vec4 topCol = compositeProcessed(topUV);
    vec4 bottomCol = compositeProcessed(bottomUV);
    float alpha = clamp(u_halfOverlayAlpha, 0.0, 1.0);
    outColor = vec4(mix(topCol.rgb, bottomCol.rgb, alpha), 1.0);
    return;
  }

  outColor = compositeProcessed(viewportSampleUV(v_uv));
}
`;

interface RenderTarget {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

interface ProgramInfo {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
}

export class WebGLRenderer implements ChromashiftRenderer {
  readonly backend = 'webgl' as const;

  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private layerProgram: ProgramInfo;
  private persistenceProgram: ProgramInfo;
  private compositorProgram: ProgramInfo;
  private currentTexture: WebGLImageTexture | null = null;
  private layerTargets: RenderTarget[] = [];
  private tracerAbove: [RenderTarget | null, RenderTarget | null] = [null, null];
  private tracerBelow: [RenderTarget | null, RenderTarget | null] = [null, null];
  private previewTarget: RenderTarget | null = null;
  private diagnosticTarget: RenderTarget | null = null;
  private pingPong: 0 | 1 = 0;
  private width = 0;
  private height = 0;
  private lastCpuMs = 0;
  private avgCpuMs = 0;
  private previewQueued: ((data: Uint8ClampedArray<ArrayBuffer>) => void) | null = null;
  private statsQueued: ((stats: CollisionStats) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.layerProgram = this.createProgram(VERTEX_SOURCE, LAYER_FRAGMENT_SOURCE);
    this.persistenceProgram = this.createProgram(PASSTHROUGH_VERTEX_SOURCE, PERSISTENCE_FRAGMENT_SOURCE);
    this.compositorProgram = this.createProgram(PASSTHROUGH_VERTEX_SOURCE, COMPOSITOR_FRAGMENT_SOURCE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  setTexture(texture: unknown): void {
    if (!isWebGLImageTexture(texture)) {
      throw new Error('WebGLRenderer expected a WebGLImageTexture.');
    }
    this.currentTexture = texture;
    this.clearPersistence();
  }

  setClassificationMaskTexture(): void {
    // WebGL fallback intentionally derives masks in GLSL from the shared source image.
  }

  setAntialiasing(): void {
    // WebGL2 fallback uses texture filtering and does not recreate MSAA targets.
  }

  clearPersistence(): void {
    const gl = this.gl;
    for (const target of [...this.tracerAbove, ...this.tracerBelow]) {
      if (!target) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.pingPong = 0;
  }

  requestPreviewReadback(callback: (data: Uint8ClampedArray<ArrayBuffer>) => void): boolean {
    if (this.previewQueued) return false;
    this.previewQueued = callback;
    return true;
  }

  requestCollisionStats(callback: (stats: CollisionStats) => void): boolean {
    if (this.statsQueued) return false;
    this.statsQueued = callback;
    return true;
  }

  getRenderTiming(): RenderTiming {
    return { lastCpuMs: this.lastCpuMs, averageCpuMs: this.avgCpuMs };
  }

  render(state: RendererState, fps = 30): void {
    if (!this.currentTexture) return;
    const start = performance.now();
    const gl = this.gl;
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    this.ensureTargets(width, height);

    const globalLayerOpacity = state.layerOpacity ?? 1.0;
    const perLayer = state.layerOpacities ?? [1, 1, 1];
    const layerOpacities: [number, number, number] = [
      globalLayerOpacity * perLayer[0],
      globalLayerOpacity * perLayer[1],
      globalLayerOpacity * perLayer[2],
    ];
    const debugMode = state.webglDebugMode ?? 0;

    for (let layerIndex = 0; layerIndex < 3; layerIndex += 1) {
      const target = this.layerTargets[layerIndex];
      const layer = state.layers[layerIndex];
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.useProgram(this.layerProgram);
      this.bindTexture('u_source', 0, this.currentTexture.texture);
      this.uniform1i('u_layerIndex', layerIndex);
      this.uniform1f('u_angleRad', (layer.angleDeg * Math.PI) / 180);
      this.uniform1f('u_flipX', layer.flipX ? 1 : 0);
      this.uniform1f('u_flipY', layer.flipY ? 1 : 0);
      this.uniform1f('u_aspect', width / height);
      this.uniform1f('u_avgLuminance', state.avgLuminance);
      this.uniform1f('u_layerOpacity', 1);
      this.uniform1f('u_colorMode', state.colorMode ?? 1);
      this.uniform1f('u_sobelEnabled', state.sobelEnabled ? 1 : 0);
      this.uniform1f('u_softCropEnabled', state.softCropEnabled ? 1 : 0);
      this.uniform1i('u_debugMode', debugMode);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    const readIndex = this.pingPong;
    const writeIndex = (1 - this.pingPong) as 0 | 1;
    const aboveDecay = durationToDecay(state.tracerAboveDuration ?? 500, fps);
    const belowDecay = durationToDecay(state.tracerBelowDuration ?? 2000, fps);
    this.renderPersistence(this.tracerAbove[writeIndex]!, this.tracerAbove[readIndex]!, aboveDecay, state);
    this.renderPersistence(this.tracerBelow[writeIndex]!, this.tracerBelow[readIndex]!, belowDecay, state);
    if (!state.paused) this.pingPong = writeIndex;

    this.renderComposite(null, width, height, state, layerOpacities);
    if (this.previewQueued) {
      this.ensurePreviewTarget();
      this.renderComposite(this.previewTarget, PREVIEW_SIZE, PREVIEW_SIZE, {
        ...state,
        viewportQuarterZoom: false,
        viewportHalfOverlay: false,
      }, layerOpacities);
      this.readPreview();
    }
    if (this.statsQueued) {
      this.ensureDiagnosticTarget();
      this.renderComposite(this.diagnosticTarget, DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE, {
        ...state,
        mainViewMode: MAIN_VIEW_MODES.COINCIDENCE_HEATMAP,
      }, layerOpacities);
      this.readStats();
    }

    const elapsed = performance.now() - start;
    this.lastCpuMs = elapsed;
    this.avgCpuMs = this.avgCpuMs === 0 ? elapsed : this.avgCpuMs * 0.9 + elapsed * 0.1;
  }

  async exportTracerView(options: ExportTracerOptions): Promise<ExportTracerResult | null> {
    if (!this.currentTexture) return null;
    const target = this.createTarget(options.width, options.height);
    const state: RendererState = {
      layers: [
        { angleDeg: 0 },
        { angleDeg: 0, flipY: true },
        { angleDeg: 0 },
      ],
      avgLuminance: 128,
      mainViewMode: MAIN_VIEW_MODES.FULL_RES_TRACER,
      tracerAboveIntensity: options.tracerAboveOpacity,
      tracerBelowIntensity: options.tracerBelowOpacity,
      tracerBlendMode: options.tracerBlendMode,
      layerBlendMode: options.layerBlendMode,
      layerOpacities: [
        options.layerOpacity0 ?? 1,
        options.layerOpacity1 ?? 1,
        options.layerOpacity2 ?? 1,
      ],
    };
    this.renderComposite(target, options.width, options.height, state, state.layerOpacities ?? [1, 1, 1]);
    const pixels = this.readTargetPixels(target, options.width, options.height);
    this.destroyTarget(target);
    return { data: pixels, width: options.width, height: options.height };
  }

  destroy(): void {
    const gl = this.gl;
    for (const target of [
      ...this.layerTargets,
      ...this.tracerAbove.filter(isRenderTarget),
      ...this.tracerBelow.filter(isRenderTarget),
      this.previewTarget,
      this.diagnosticTarget,
    ]) {
      if (target) this.destroyTarget(target);
    }
    for (const info of [this.layerProgram, this.persistenceProgram, this.compositorProgram]) {
      gl.deleteProgram(info.program);
    }
  }

  private ensureTargets(width: number, height: number): void {
    if (this.width === width && this.height === height && this.layerTargets.length === 3) return;
    for (const target of [
      ...this.layerTargets,
      ...this.tracerAbove.filter(isRenderTarget),
      ...this.tracerBelow.filter(isRenderTarget),
    ]) {
      this.destroyTarget(target);
    }
    this.layerTargets = [0, 1, 2].map(() => this.createTarget(width, height));
    this.tracerAbove = [this.createTarget(width, height), this.createTarget(width, height)];
    this.tracerBelow = [this.createTarget(width, height), this.createTarget(width, height)];
    this.width = width;
    this.height = height;
    this.clearPersistence();
  }

  private renderPersistence(target: RenderTarget, previous: RenderTarget, decay: number, state: RendererState): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    this.useProgram(this.persistenceProgram);
    this.bindTexture('u_layer0', 0, this.layerTargets[0].texture);
    this.bindTexture('u_layer1', 1, this.layerTargets[1].texture);
    this.bindTexture('u_layer2', 2, this.layerTargets[2].texture);
    this.bindTexture('u_previous', 3, previous.texture);
    this.uniform1f('u_decay', state.paused ? 1 : decay);
    this.uniform1f('u_stampBoost', state.stampBoost ?? 1.8);
    this.uniform1i('u_tracerMode', state.tracerMode ?? 0);
    this.uniform1i('u_peakMode', state.peakCollisionsOnly ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private renderComposite(
    target: RenderTarget | null,
    width: number,
    height: number,
    state: RendererState,
    layerOpacities: [number, number, number],
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.useProgram(this.compositorProgram);
    this.bindTexture('u_layer0', 0, this.layerTargets[0].texture);
    this.bindTexture('u_layer1', 1, this.layerTargets[1].texture);
    this.bindTexture('u_layer2', 2, this.layerTargets[2].texture);
    this.bindTexture('u_tracerBelow', 3, this.tracerBelow[this.pingPong]!.texture);
    this.bindTexture('u_tracerAbove', 4, this.tracerAbove[this.pingPong]!.texture);
    this.uniform1f('u_layerOpacity0', layerOpacities[0]);
    this.uniform1f('u_layerOpacity1', layerOpacities[1]);
    this.uniform1f('u_layerOpacity2', layerOpacities[2]);
    this.uniform1f('u_tracerBelowOpacity', state.tracerBelowIntensity ?? 0.3);
    this.uniform1f('u_tracerAboveOpacity', state.tracerAboveIntensity ?? 0.85);
    this.uniform1i('u_layerBlendMode', state.layerBlendMode ?? 0);
    this.uniform1i('u_tracerBlendMode', state.tracerBlendMode ?? 0);
    this.uniform1i('u_outputMode', state.outputMode ?? 0);
    this.uniform1i('u_mainViewMode', state.mainViewMode ?? MAIN_VIEW_MODES.PROCESSED_COMPOSITE);
    this.uniform1i('u_diagnosticsMode', state.diagnosticsMode ? 1 : 0);
    this.uniform1f('u_diagnosticsOpacity', state.diagnosticsOpacity ?? 0.55);
    const zoomEnabled = (state.viewportQuarterZoom ?? false)
      && (state.mainViewMode ?? MAIN_VIEW_MODES.PROCESSED_COMPOSITE) === MAIN_VIEW_MODES.PROCESSED_COMPOSITE;
    const overlayEnabled = (state.viewportHalfOverlay ?? false)
      && (state.mainViewMode ?? MAIN_VIEW_MODES.PROCESSED_COMPOSITE) === MAIN_VIEW_MODES.PROCESSED_COMPOSITE;
    this.uniform1i('u_viewportQuarterZoom', zoomEnabled ? 1 : 0);
    this.uniform1i('u_viewportHalfOverlay', overlayEnabled ? 1 : 0);
    this.uniform1f('u_halfOverlayAlpha', state.halfOverlayAlpha ?? 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private ensurePreviewTarget(): void {
    this.previewTarget ??= this.createTarget(PREVIEW_SIZE, PREVIEW_SIZE);
  }

  private ensureDiagnosticTarget(): void {
    this.diagnosticTarget ??= this.createTarget(DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE);
  }

  private readPreview(): void {
    if (!this.previewTarget || !this.previewQueued) return;
    const callback = this.previewQueued;
    this.previewQueued = null;
    callback(this.readTargetPixels(this.previewTarget, PREVIEW_SIZE, PREVIEW_SIZE));
  }

  private readStats(): void {
    if (!this.diagnosticTarget || !this.statsQueued) return;
    const callback = this.statsQueued;
    this.statsQueued = null;
    const pixels = this.readTargetPixels(this.diagnosticTarget, DIAGNOSTIC_SIZE, DIAGNOSTIC_SIZE);
    const stats: CollisionStats = {
      sampledPixels: DIAGNOSTIC_SIZE * DIAGNOSTIC_SIZE,
      twoOverlapPixels: 0,
      threeOverlapPixels: 0,
      dominantLayerWins: [0, 0, 0],
      averageCollision: 0,
    };
    let sum = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const hit = Math.max(r, g, b) / 255;
      sum += hit;
      if (r > 200 && g > 170) stats.threeOverlapPixels += 1;
      else if (b > 180 || g > 150) stats.twoOverlapPixels += 1;
      if (r >= g && r >= b) stats.dominantLayerWins[0] += 1;
      else if (g >= b) stats.dominantLayerWins[1] += 1;
      else stats.dominantLayerWins[2] += 1;
    }
    stats.averageCollision = sum / stats.sampledPixels;
    callback(stats);
  }

  private readTargetPixels(target: RenderTarget, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
    const gl = this.gl;
    const data = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const flipped = new Uint8ClampedArray(width * height * 4);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y += 1) {
      const srcOffset = (height - 1 - y) * rowBytes;
      const dstOffset = y * rowBytes;
      flipped.set(data.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
    }
    return flipped;
  }

  private createTarget(width: number, height: number): RenderTarget {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error('Failed to create WebGL render target.');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      throw new Error('WebGL framebuffer is incomplete.');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer, width, height };
  }

  private destroyTarget(target: RenderTarget): void {
    this.gl.deleteTexture(target.texture);
    this.gl.deleteFramebuffer(target.framebuffer);
  }

  private createProgram(vertexSource: string, fragmentSource: string): ProgramInfo {
    const gl = this.gl;
    const vertex = this.createShader(gl.VERTEX_SHADER, vertexSource);
    const fragment = this.createShader(gl.FRAGMENT_SHADER, fragmentSource);
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

  private createShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
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

  private useProgram(info: ProgramInfo): void {
    this.gl.useProgram(info.program);
  }

  private uniformLocation(name: string): WebGLUniformLocation | null {
    const program = this.gl.getParameter(this.gl.CURRENT_PROGRAM) as WebGLProgram | null;
    if (!program) return null;
    const info = [this.layerProgram, this.persistenceProgram, this.compositorProgram]
      .find((entry) => entry.program === program);
    if (!info) return null;
    if (!info.uniforms.has(name)) {
      const location = this.gl.getUniformLocation(program, name);
      if (location) info.uniforms.set(name, location);
      return location;
    }
    return info.uniforms.get(name) ?? null;
  }

  private uniform1f(name: string, value: number): void {
    const location = this.uniformLocation(name);
    if (location) this.gl.uniform1f(location, value);
  }

  private uniform1i(name: string, value: number): void {
    const location = this.uniformLocation(name);
    if (location) this.gl.uniform1i(location, value);
  }

  private bindTexture(name: string, unit: number, texture: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    this.uniform1i(name, unit);
  }
}

function durationToDecay(durationMs: number, fps: number): number {
  if (durationMs <= 0) return 0;
  const frames = fps * durationMs / 1000;
  if (frames < 1) return 0;
  return Math.pow(0.1, 1 / frames);
}

function isWebGLImageTexture(texture: unknown): texture is WebGLImageTexture {
  return typeof texture === 'object' && texture !== null && (texture as WebGLImageTexture).kind === 'webgl-image-texture';
}

function isRenderTarget(target: RenderTarget | null): target is RenderTarget {
  return target !== null;
}
