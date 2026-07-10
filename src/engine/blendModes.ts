// Blend-mode metadata for UI display and documentation.
// Formulas reference W3C Compositing and Blending Level 1 and match the
// WGSL implementation in shaders.ts exactly.

export interface BlendModeInfo {
  id: number;
  name: string;
  formula: string;
  description: string;
}

export const BLEND_MODES: BlendModeInfo[] = [
  {
    id: 0,
    name: "Alpha",
    formula: "src + dst × (1 − src.a)",
    description:
      "Standard source-over compositing on premultiplied colours. Use this when you want normal layer stacking.",
  },
  {
    id: 1,
    name: "Add",
    formula: "min(dst + src, 1)",
    description:
      "Adds RGB channels together and clamps to white. Produces bright, saturated overlaps — good for glow and light effects.",
  },
  {
    id: 2,
    name: "Subtract",
    formula: "max(dst − src, 0)",
    description:
      "Subtracts the source from the backdrop. Clamped to black. Useful for darkening or inverting regions.",
  },
  {
    id: 3,
    name: "Multiply",
    formula: "dst × src",
    description:
      "Darkens by multiplying channels. The result is always darker than both inputs. White is the identity colour.",
  },
  {
    id: 4,
    name: "Screen",
    formula: "1 − (1 − dst) × (1 − src)",
    description:
      "Lightens by inverting, multiplying, then inverting back. The result is always lighter than both inputs. Black is the identity colour.",
  },
  {
    id: 5,
    name: "Lighten",
    formula: "max(dst, src)",
    description:
      "Keeps the lighter of each RGB channel. Good for highlights and star-field effects.",
  },
  {
    id: 6,
    name: "Darken",
    formula: "min(dst, src)",
    description:
      "Keeps the darker of each RGB channel. Good for shadows and deepening.",
  },
  {
    id: 7,
    name: "Overlay",
    formula: "dst < 0.5 ? 2×dst×src : 1 − 2×(1−dst)×(1−src)",
    description:
      "Uses the BACKDROP to decide between Multiply and Screen. Follows Photoshop / W3C convention. Increases contrast.",
  },
  {
    id: 8,
    name: "Color Dodge",
    formula: "clamp(dst / (1 − src), 0, 1)",
    description:
      "Brightens the backdrop based on the source. Dark source colours have little effect; bright colours push the result toward white.",
  },
  {
    id: 9,
    name: "Color Burn",
    formula: "clamp(1 − (1 − dst) / src, 0, 1)",
    description:
      "Darkens the backdrop based on the source. Bright source colours have little effect; dark colours push the result toward black.",
  },
  {
    id: 10,
    name: "Difference",
    formula: "|dst − src|",
    description:
      "Absolute difference between channels. Produces high-contrast edges and psychedelic inversions.",
  },
  {
    id: 11,
    name: "Exclusion",
    formula: "dst + src − 2×dst×src",
    description:
      "Similar to Difference but softer, with low-contrast areas going to grey instead of black. Self-clamping in [0,1].",
  },
  {
    id: 12,
    name: "Hard Light",
    formula: "src < 0.5 ? 2×dst×src : 1 − 2×(1−dst)×(1−src)",
    description:
      "Uses the SOURCE to decide between Multiply and Screen. Follows Photoshop / W3C convention. More aggressive than Overlay.",
  },
];

export function getBlendModeInfo(id: number): BlendModeInfo | undefined {
  return BLEND_MODES.find((m) => m.id === id);
}

// ─── Runtime blend math (mirrors WGSL blend() in shaders.ts) ─────────────────

export type Rgba = readonly [r: number, g: number, b: number, a: number];

const BLEND_EPSILON = 0.0001;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function unpremultiply(color: Rgba): Rgba {
  const [, , , a] = color;
  if (a < BLEND_EPSILON) return [0, 0, 0, 0];
  const invA = 1 / a;
  return [
    clamp01(color[0] * invA),
    clamp01(color[1] * invA),
    clamp01(color[2] * invA),
    a,
  ];
}

function alphaBlend(dst: Rgba, src: Rgba): Rgba {
  const srcScale = 1 - dst[3];
  return [
    src[0] + dst[0] * srcScale,
    src[1] + dst[1] * srcScale,
    src[2] + dst[2] * srcScale,
    src[3] + dst[3] * srcScale,
  ];
}

function blendChannel(mode: number, d: number, s: number): number {
  switch (mode) {
    case 1:
      return Math.min(d + s, 1);
    case 2:
      return Math.max(d - s, 0);
    case 3:
      return d * s;
    case 4:
      return 1 - (1 - d) * (1 - s);
    case 5:
      return Math.max(d, s);
    case 6:
      return Math.min(d, s);
    case 7:
      return d < 0.5 ? 2 * d * s : 1 - 2 * (1 - d) * (1 - s);
    case 8: {
      const denom = Math.max(1 - s, BLEND_EPSILON);
      return clamp01(d / denom);
    }
    case 9: {
      const src = Math.max(s, BLEND_EPSILON);
      return clamp01(1 - (1 - d) / src);
    }
    case 10:
      return Math.abs(d - s);
    case 11:
      return d + s - 2 * d * s;
    case 12:
      return s < 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d);
    default:
      return s;
  }
}

function blendRgb(mode: number, dst: Rgba, src: Rgba): [number, number, number] {
  return [
    blendChannel(mode, dst[0], src[0]),
    blendChannel(mode, dst[1], src[1]),
    blendChannel(mode, dst[2], src[2]),
  ];
}

/** Porter-Duff source-over and custom W3C blend modes on premultiplied RGBA. */
export function applyBlend(dst: Rgba, src: Rgba, mode: number): Rgba {
  if (mode === 0 || mode > 12) {
    return alphaBlend(dst, src);
  }

  const s = unpremultiply(src);
  const d = unpremultiply(dst);
  const [r, g, b] = blendRgb(mode, d, s);

  const outAlpha = s[3] + d[3] * (1 - s[3]);
  if (outAlpha < BLEND_EPSILON) {
    return [0, 0, 0, 0];
  }

  const outRgb = [
    (s[0] * s[3] * (1 - d[3]) + d[0] * d[3] * (1 - s[3]) + r * s[3] * d[3]) / outAlpha,
    (s[1] * s[3] * (1 - d[3]) + d[1] * d[3] * (1 - s[3]) + g * s[3] * d[3]) / outAlpha,
    (s[2] * s[3] * (1 - d[3]) + d[2] * d[3] * (1 - s[3]) + b * s[3] * d[3]) / outAlpha,
  ] as const;

  return [outRgb[0] * outAlpha, outRgb[1] * outAlpha, outRgb[2] * outAlpha, outAlpha];
}
