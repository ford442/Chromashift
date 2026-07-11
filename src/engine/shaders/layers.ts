import { BAND_WGSL, WGSL_COLOR_HELPERS } from './common';

const B = BAND_WGSL;

// Bindings + uniforms shared verbatim by the three layer fragment shaders.
const LAYER_FRAG_HEADER = /* wgsl */ `
${WGSL_COLOR_HELPERS}
@group(0) @binding(1) var texSampler : sampler;
@group(0) @binding(2) var tex        : texture_2d<f32>;
@group(0) @binding(4) var classMask  : texture_2d<u32>;

struct FragUniforms {
  avgLuminance     : f32,
  layerOpacity     : f32,
  colorMode        : f32,
  useMask          : f32,
  sobelEnabled     : f32,
  softCropEnabled  : f32,
  _pad0            : f32,
  _pad1            : f32,
};
@group(0) @binding(3) var<uniform> fragUniforms : FragUniforms;
`;

// Per-pixel luminance + classification-mask lookup at the top of each main().
const LAYER_FRAG_PRELUDE = /* wgsl */ `
  let sample = textureSample(tex, texSampler, uv);
  let rawLum = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)) * 255.0;
  let lum    = sobelBoostedLuminance(tex, texSampler, uv, rawLum, fragUniforms.sobelEnabled);
  let dims   = vec2<f32>(textureDimensions(classMask));
  let maskUv = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.99999994));
  let maskPx = vec2<i32>(maskUv * dims);
  let band   = textureLoad(classMask, maskPx, 0).r;

  var result = vec4<f32>(0.0, 0.0, 0.0, 0.0);
`;

// ─── Fragment: Layer 0 – Red / Orange ──────────────────────────────────────────────
export const fragmentShaderRedOrange = /* wgsl */ `
${LAYER_FRAG_HEADER}
@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
${LAYER_FRAG_PRELUDE}
  if (fragUniforms.colorMode == 1.0) {
    // --- CHROMASHIFT GRADIENT ---
    if (lum > ${B.greyHighlight})      { result = vec4<f32>(band_gradient(lum, ${B.greyHighlight}, 255.0, 45.0, 60.0, 0.3, 0.80, 1.0), 1.0); }
    else if (lum > ${B.orange}) { result = vec4<f32>(band_gradient(lum, ${B.orange}, ${B.greyHighlight}, 10.0, 40.0, 1.0, 0.50, 0.65), 1.0); }
    else if (lum > ${B.borderRed}) { result = vec4<f32>(band_gradient(lum, ${B.borderRed}, ${B.orange}, 0.0, 10.0, 1.0, 0.40, 0.55), 1.0); }
  } else if (fragUniforms.colorMode >= 1.5) {
    // --- CROP MODE (2.0) / CROP NUNIF2 (3.0) ---
    let isNunif2  = fragUniforms.colorMode > 2.5;
    // CR0P (mode 2) maps pixels straight from raw luminance so its bands line up
    // exactly with the go.1ink.us/chromashift reference. NUNIF2 (mode 3) keeps the
    // luminance lift: lum += (128 + |avgLum - 128| / 2) / 2.
    let adj       = lum + (128.0 + abs(fragUniforms.avgLuminance - 128.0) * 0.5) * 0.5;
    let bandLum   = select(lum, adj, isNunif2);
    let nonAlpha  = select(1.0, 0.5, isNunif2);   // NUNIF2 Layer 1 opacity = 0.5
    let darkAlpha = select(0.0, 0.1, isNunif2);
    result = cropLayer0Color(bandLum, fragUniforms.softCropEnabled, nonAlpha, darkAlpha);
  } else {
    // --- ORIGINAL CR0P FIXED ---
    let diff      = (fragUniforms.avgLuminance / 255.0) * 32.0;
    let lightDark = 128.0 + (abs(fragUniforms.avgLuminance - 128.0) / 2.0);
    let rgb       = lum + lightDark / 2.0;
    let grey      = fragUniforms.avgLuminance;
    let useMask   = fragUniforms.useMask > 0.5;

    if (useMask) {
      if (band == 0u) {
        let g = clamp((grey + (rgb - ${B.greyHighlight})) / 255.0, 0.0, 1.0);
        result = vec4<f32>(g, g, g, 1.0);
      } else if (band == 1u) {
        result = vec4<f32>(1.0, (128.0 - diff) / 255.0, 0.0, 1.0);
      } else if (band == 2u) {
        result = vec4<f32>((255.0 - diff) / 255.0, 0.0, 0.0, 1.0);
      } else if (band == 3u) {
        result = vec4<f32>(1.0, 0.0, 0.0, 1.0);
      } else if (band == 10u) {
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        result = vec4<f32>(g, g, g, 1.0);
      }
    } else {
      // Softened thresholds (see softThreshold helper above). The 2.2-unit
      // transition width gives noticeably smoother edges on real photos
      // without destroying the distinct colour band identity.
      let tw = 2.2;
      if (rgb > ${B.greyHighlight} - tw) {
        let t = softThreshold(rgb, ${B.greyHighlight}, tw);
        let g = clamp((grey + (rgb - ${B.greyHighlight})) / 255.0, 0.0, 1.0);
        // Fade highlight grey into the orange band for anti-aliasing
        let orange = vec4<f32>(1.0, (128.0 - diff) / 255.0, 0.0, 1.0);
        result = mix(orange, vec4<f32>(g, g, g, 1.0), t);
      } else if (rgb > ${B.orange}) {
        result = vec4<f32>(1.0, (128.0 - diff) / 255.0, 0.0, 1.0);
      } else if (rgb > ${B.red}) {
        result = vec4<f32>((255.0 - diff) / 255.0, 0.0, 0.0, 1.0);
      } else if (rgb > ${B.borderRed}) {
        result = vec4<f32>(1.0, 0.0, 0.0, 1.0);
      } else if (rgb <= 126.0 + tw) {
        let t = 1.0 - softThreshold(rgb, 126.0, tw);
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        // Blend dark grey into the lowest red band
        let borderRed = vec4<f32>(1.0, 0.0, 0.0, 1.0);
        result = mix(vec4<f32>(g, g, g, 1.0), borderRed, t);
      }
    }
  }

  return result;
}`;

// ─── Fragment: Layer 1 – Violet / Blue ──────────────────────────────────────────────
export const fragmentShaderVioletBlue = /* wgsl */ `
${LAYER_FRAG_HEADER}
@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
${LAYER_FRAG_PRELUDE}
  if (fragUniforms.colorMode == 1.0) {
    // --- CHROMASHIFT GRADIENT ---
    if (lum > ${B.violet} && lum <= ${B.borderRed})      { result = vec4<f32>(band_gradient(lum, ${B.violet}, ${B.borderRed}, 255.0, 290.0, 1.0, 0.40, 0.55), 1.0); }
    else if (lum > ${B.borderBlue} && lum <= ${B.violet}) { result = vec4<f32>(band_gradient(lum, ${B.borderBlue}, ${B.violet}, 220.0, 255.0, 1.0, 0.38, 0.50), 1.0); }
  } else if (fragUniforms.colorMode >= 1.5) {
    // --- CROP MODE (2.0) / CROP NUNIF2 (3.0) ---
    let isNunif2  = fragUniforms.colorMode > 2.5;
    // CR0P (mode 2) uses raw luminance to match the go.1ink.us/chromashift reference;
    // NUNIF2 (mode 3) keeps its luminance lift.
    let adj       = lum + (128.0 + abs(fragUniforms.avgLuminance - 128.0) * 0.5) * 0.5;
    let bandLum   = select(lum, adj, isNunif2);
    let nonAlpha  = select(1.0, 0.777, isNunif2);  // NUNIF2 Layer 2 opacity = 0.777
    let darkAlpha = select(0.0, 0.1, isNunif2);
    result = cropLayer1Color(bandLum, fragUniforms.softCropEnabled, nonAlpha, darkAlpha);
  } else {
    // --- ORIGINAL CR0P FIXED ---
    let diff      = (fragUniforms.avgLuminance / 255.0) * 32.0;
    let lightDark = 128.0 + (abs(fragUniforms.avgLuminance - 128.0) / 2.0);
    let rgb       = lum + lightDark / 2.0;
    let grey      = fragUniforms.avgLuminance;
    let useMask   = fragUniforms.useMask > 0.5;

    if (useMask) {
      if (band == 4u) {
        result = vec4<f32>((128.0 - diff) / 255.0, 0.0, 1.0, 1.0);
      } else if (band == 5u) {
        result = vec4<f32>(0.0, 0.0, (255.0 - diff) / 255.0, 1.0);
      } else if (band == 6u) {
        result = vec4<f32>(0.0, 0.0, 1.0, 1.0);
      } else if (band == 10u) {
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        result = vec4<f32>(g, g, g, 1.0);
      }
    } else {
      let tw = 2.2; // must match the value used in Red/Orange for consistent edges
      if (rgb > ${B.violet} && rgb <= ${B.borderRed}) {
        result = vec4<f32>((128.0 - diff) / 255.0, 0.0, 1.0, 1.0);
      } else if (rgb > ${B.blue} && rgb <= ${B.violet}) {
        result = vec4<f32>(0.0, 0.0, (255.0 - diff) / 255.0, 1.0);
      } else if (rgb > ${B.borderBlue} && rgb <= ${B.blue}) {
        result = vec4<f32>(0.0, 0.0, 1.0, 1.0);
      } else if (rgb <= 126.0 + tw) {
        let t = 1.0 - softThreshold(rgb, 126.0, tw);
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        let borderBlue = vec4<f32>(0.0, 0.0, 1.0, 1.0);
        result = mix(vec4<f32>(g, g, g, 1.0), borderBlue, t);
      }
    }
  }

  return result;
}`;

// ─── Fragment: Layer 2 – Green / Yellow ──────────────────────────────────────────────
export const fragmentShaderGreenYellow = /* wgsl */ `
${LAYER_FRAG_HEADER}
@fragment
fn main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
${LAYER_FRAG_PRELUDE}
  if (fragUniforms.colorMode == 1.0) {
    // --- CHROMASHIFT GRADIENT ---
    if (lum > ${B.green} && lum <= ${B.borderBlue})      { result = vec4<f32>(band_gradient(lum, ${B.green}, ${B.borderBlue}, 90.0, 130.0, 1.0, 0.38, 0.50), 1.0); }
    else if (lum > ${B.borderYellow} && lum <= ${B.green}) { result = vec4<f32>(band_gradient(lum, ${B.borderYellow}, ${B.green}, 50.0, 90.0, 1.0, 0.40, 0.52), 1.0); }
  } else if (fragUniforms.colorMode >= 1.5) {
    // --- CROP MODE (2.0) / CROP NUNIF2 (3.0) ---
    let isNunif2  = fragUniforms.colorMode > 2.5;
    // CR0P (mode 2) uses raw luminance to match the go.1ink.us/chromashift reference;
    // NUNIF2 (mode 3) keeps its luminance lift.
    let adj       = lum + (128.0 + abs(fragUniforms.avgLuminance - 128.0) * 0.5) * 0.5;
    let bandLum   = select(lum, adj, isNunif2);
    let nonAlpha  = select(1.0, 0.777, isNunif2);  // NUNIF2 Layer 3 opacity = 0.777
    let darkAlpha = select(0.0, 0.1, isNunif2);
    result = cropLayer2Color(bandLum, fragUniforms.softCropEnabled, nonAlpha, darkAlpha);
  } else {
    // --- ORIGINAL CR0P FIXED ---
    let diff      = (fragUniforms.avgLuminance / 255.0) * 32.0;
    let lightDark = 128.0 + (abs(fragUniforms.avgLuminance - 128.0) / 2.0);
    let rgb       = lum + lightDark / 2.0;
    let grey      = fragUniforms.avgLuminance;
    let useMask   = fragUniforms.useMask > 0.5;

    if (useMask) {
      if (band == 7u) {
        result = vec4<f32>(0.0, (255.0 - diff) / 255.0, 0.0, 1.0);
      } else if (band == 8u) {
        result = vec4<f32>(1.0, (255.0 - diff) / 255.0, 0.0, 1.0);
      } else if (band == 9u) {
        result = vec4<f32>(1.0, 1.0, 0.0, 1.0);
      } else if (band == 10u) {
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        result = vec4<f32>(g, g, g, 1.0);
      }
    } else {
      let tw = 2.2; // consistent with other layers for coherent soft edges across bands
      if (rgb > ${B.green} && rgb <= ${B.borderBlue}) {
        result = vec4<f32>(0.0, (255.0 - diff) / 255.0, 0.0, 1.0);
      } else if (rgb > ${B.yellow} && rgb <= ${B.green}) {
        result = vec4<f32>(1.0, (255.0 - diff) / 255.0, 0.0, 1.0);
      } else if (rgb > ${B.borderYellow} && rgb <= ${B.yellow}) {
        result = vec4<f32>(1.0, 1.0, 0.0, 1.0);
      } else if (rgb <= 126.0 + tw) {
        let t = 1.0 - softThreshold(rgb, 126.0, tw);
        let g = clamp((grey - (rgb - 128.0)) / 255.0, 0.0, 1.0);
        let borderYellow = vec4<f32>(1.0, 1.0, 0.0, 1.0);
        result = mix(vec4<f32>(g, g, g, 1.0), borderYellow, t);
      }
    }
  }

  return result;
}
`;
