export const COMPOSITOR_FRAGMENT_SOURCE = `#version 300 es
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
