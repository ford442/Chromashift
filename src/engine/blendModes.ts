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
