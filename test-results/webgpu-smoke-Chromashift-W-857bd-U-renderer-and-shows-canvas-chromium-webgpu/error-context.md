# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: webgpu-smoke.spec.ts >> Chromashift WebGPU smoke >> boots with WebGPU renderer and shows canvas
- Location: e2e/webgpu-smoke.spec.ts:5:3

# Error details

```
Error: WebGPU bootstrap timed out after 45000ms: {"rendererFallbackReason":null,"hasNavigatorGpu":true,"gpuErrorVisible":true}
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e8]: Original
  - generic [ref=e11]: Separated
  - generic [ref=e14]:
    - generic [ref=e15]: Composite
    - generic [ref=e16]:
      - button "Live" [ref=e17]
      - button "Preview On" [ref=e18]
  - button "⏸ Pause" [ref=e20]
  - button "Browse Images" [ref=e22]
  - generic [ref=e23]:
    - generic [ref=e24]: "Avg Lum: 128"
    - slider [ref=e25] [cursor=pointer]: "128"
    - generic [ref=e26]: 🔷 TS
    - generic [ref=e27]: CPU 0.00 / 0.00 ms
    - generic [ref=e28]: 2+ 0 | 3 0
    - generic [ref=e29]: Win 0/0/0
  - generic [ref=e31]:
    - paragraph [ref=e32]: WebGL2 is not supported in this browser.
    - paragraph [ref=e33]: Use Chrome/Edge with WebGPU, or open with ?renderer=webgl for the WebGL2 fallback.
    - generic [ref=e34]:
      - button "Reload page" [ref=e35]
      - button "Switch to WebGL2" [ref=e36]
  - generic [ref=e37]:
    - generic [ref=e38]:
      - generic [ref=e39]: ✨ NUNIF Controls
      - generic [ref=e40]:
        - button "⏸" [ref=e41]
        - button "⟲" [ref=e42]
    - generic [ref=e44]:
      - generic [ref=e45]:
        - text: "Image:"
        - generic [ref=e46]: 5s
      - slider [ref=e47] [cursor=pointer]: "5"
    - generic [ref=e48]:
      - generic [ref=e49]: 📷 Load
      - generic [ref=e50]:
        - button "URL" [ref=e51]
        - button "File" [ref=e52]
      - button "Browse Images" [ref=e53]
    - generic [ref=e54]:
      - generic [ref=e55]: 🖼 Reference
      - generic [ref=e56]: No reference loaded
      - generic [ref=e57]:
        - button "Ref URL" [ref=e58]
        - button "Ref File" [ref=e59]
    - generic [ref=e60]:
      - button "🎛 Renderer & Engine ▼" [expanded] [ref=e61]:
        - generic [ref=e62]: 🎛 Renderer & Engine
        - generic [ref=e63]: ▼
      - generic [ref=e64]:
        - generic [ref=e66]:
          - generic [ref=e67]:
            - generic [ref=e68]: Renderer
            - generic [ref=e69]: "Active: WEBGPU"
          - generic [ref=e70]:
            - button "WEBGPU" [ref=e71]
            - button "WEBGL" [ref=e72]
        - generic [ref=e73]:
          - generic [ref=e74]: ⚡ Engine
          - generic [ref=e75]:
            - button "TS" [ref=e76]
            - button "C++ WASM" [ref=e77]
          - generic [ref=e78]: 🔷 TypeScript active
    - generic [ref=e79]:
      - button "🌍 Layers & Global ▼" [expanded] [ref=e80]:
        - generic [ref=e81]: 🌍 Layers & Global
        - generic [ref=e82]: ▼
      - generic [ref=e83]:
        - generic [ref=e84]:
          - generic [ref=e85]:
            - generic [ref=e86]: Layer 0 — Red/Orange(reverse)
            - generic [ref=e87]:
              - generic [ref=e88]:
                - generic [ref=e96]: "0"
                - generic [ref=e97]:
                  - generic [ref=e98]: Angle
                  - generic [ref=e99]: °
              - generic [ref=e100]:
                - generic [ref=e108]: "130"
                - generic [ref=e109]:
                  - generic [ref=e110]: Step
                  - generic [ref=e111]: °
          - generic [ref=e112]:
            - generic [ref=e113]: Layer 1 — Violet/Blue
            - generic [ref=e114]:
              - generic [ref=e115]:
                - generic [ref=e123]: "0"
                - generic [ref=e124]:
                  - generic [ref=e125]: Angle
                  - generic [ref=e126]: °
              - generic [ref=e127]:
                - generic [ref=e135]: "230"
                - generic [ref=e136]:
                  - generic [ref=e137]: Step
                  - generic [ref=e138]: °
          - generic [ref=e139]:
            - generic [ref=e140]: Layer 2 — Green/Yellow
            - generic [ref=e141]:
              - generic [ref=e142]:
                - generic [ref=e150]: "0"
                - generic [ref=e151]:
                  - generic [ref=e152]: Angle
                  - generic [ref=e153]: °
              - generic [ref=e154]:
                - generic [ref=e162]: "330"
                - generic [ref=e163]:
                  - generic [ref=e164]: Step
                  - generic [ref=e165]: °
        - generic [ref=e166]:
          - generic [ref=e167]:
            - generic [ref=e168]: "FPS: 30"
            - slider [ref=e169] [cursor=pointer]: "30"
          - generic [ref=e170]:
            - generic [ref=e171]:
              - text: "Opac:"
              - generic [ref=e172]: 100%
            - slider [ref=e173] [cursor=pointer]: "1"
          - generic [ref=e174]:
            - generic [ref=e175]:
              - generic [ref=e176]:
                - text: "L0:"
                - generic [ref=e177]: 100%
              - slider [ref=e178] [cursor=pointer]: "1"
            - generic [ref=e179]:
              - generic [ref=e180]:
                - text: "L1:"
                - generic [ref=e181]: 100%
              - slider [ref=e182] [cursor=pointer]: "1"
            - generic [ref=e183]:
              - generic [ref=e184]:
                - text: "L2:"
                - generic [ref=e185]: 100%
              - slider [ref=e186] [cursor=pointer]: "1"
          - generic [ref=e187]:
            - text: "Spectrum:"
            - generic [ref=e188]:
              - button "🧱 Fixed" [ref=e189]
              - button "🌈 Vivid" [ref=e190]
              - button "🌿 CROP" [ref=e191]
              - button "📺 N2" [ref=e192]
          - generic [ref=e193]:
            - text: "Band shaping:"
            - generic [ref=e194]:
              - button "○ Sobel" [ref=e195]
              - button "≈ Soft" [ref=e196]
          - generic [ref=e197]:
            - generic [ref=e198]:
              - text: "Layer:"
              - generic [ref=e199]: 1.0x
            - slider [ref=e200] [cursor=pointer]: "1"
          - generic [ref=e201]:
            - generic [ref=e202]:
              - text: "Tracer:"
              - generic [ref=e203]: 1.0x
            - slider [ref=e204] [cursor=pointer]: "1"
    - generic [ref=e205]:
      - button "✨ Dual Tracer ▼" [expanded] [ref=e206]:
        - generic [ref=e207]: ✨ Dual Tracer
        - generic [ref=e208]: ▼
      - generic [ref=e209]:
        - generic [ref=e210]:
          - generic [ref=e211]: ⬆ Top Layer
          - generic [ref=e212]:
            - generic [ref=e213]: "Opac:"
            - slider [ref=e214] [cursor=pointer]: "0.85"
            - generic [ref=e215]: 85%
          - generic [ref=e216]:
            - generic [ref=e217]: "Hold:"
            - slider [ref=e218] [cursor=pointer]: "500"
            - generic [ref=e219]: 0.5s
        - generic [ref=e220]:
          - generic [ref=e221]: ⬇ Base Layer
          - generic [ref=e222]:
            - generic [ref=e223]: "Opac:"
            - slider [ref=e224] [cursor=pointer]: "0.3"
            - generic [ref=e225]: 30%
          - generic [ref=e226]:
            - generic [ref=e227]: "Hold:"
            - slider [ref=e228] [cursor=pointer]: "2000"
            - generic [ref=e229]: 2.0s
        - generic [ref=e230]:
          - generic [ref=e231]:
            - generic [ref=e232]: "Mode:"
            - button "🎨" [ref=e233]
          - button "🔬 Show Full Tracer" [ref=e234]
          - generic [ref=e235]:
            - text: "Main View:"
            - combobox [ref=e236]:
              - option "Current Processed Output" [selected]
              - option "Full-Res Tracer"
              - option "Source Photo"
              - option "Reference Photo"
              - option "Previous Image"
              - option "Reference | Composite"
              - option "Layer 0 Isolation"
              - option "Layer 1 Isolation"
              - option "Layer 2 Isolation"
              - option "Coincidence Heatmap"
              - 'option "Compare: Source | Composite"'
              - option "Stamp Diagnostics"
            - generic [ref=e237]: "Src: —"
            - generic [ref=e238]: "Ref: —"
            - generic [ref=e239]:
              - text: "Blend Overlay:"
              - combobox [ref=e240]:
                - option "Source (follows autoplay)"
                - option "Reference" [selected]
                - option "Previous"
                - option "Separated output"
            - generic [ref=e241]:
              - combobox [ref=e242]:
                - option "Hidden" [selected]
                - option "Alpha overlay"
                - option "Split"
                - option "Checker"
                - option "Difference"
                - option "Edge"
              - generic [ref=e243]:
                - generic [ref=e244]: 22%
                - slider [ref=e245] [cursor=pointer]: "0.22"
          - generic [ref=e246]:
            - text: "Composite Stack:"
            - generic [ref=e247]:
              - button "Mixed" [ref=e248]
              - button "Focus" [ref=e249]
              - button "Only" [ref=e250]
              - button "Peak" [ref=e251]
          - generic [ref=e252]:
            - button "Swap Src/Ref" [ref=e253]
            - button "Open Browser" [ref=e254]
        - generic [ref=e255]:
          - generic [ref=e256]: 🔀 Blend
          - generic [ref=e257]:
            - generic [ref=e258]:
              - generic [ref=e259]: "Layer:"
              - combobox [ref=e260]:
                - option "Alpha" [selected]
                - option "Add"
                - option "Subtract"
                - option "Multiply"
                - option "Screen"
                - option "Lighten"
                - option "Darken"
                - option "Overlay"
                - option "Color Dodge"
                - option "Color Burn"
                - option "Difference"
                - option "Exclusion"
                - option "Hard Light"
            - generic [ref=e261]:
              - text: src + dst × (1 − src.a)
              - generic [ref=e262]: — Standard source-over compositing on premultiplied colours. Use this when you want normal layer stacking.
          - generic [ref=e263]:
            - generic [ref=e264]:
              - generic [ref=e265]: "Tracer:"
              - combobox [ref=e266]:
                - option "Alpha" [selected]
                - option "Add"
                - option "Subtract"
                - option "Multiply"
                - option "Screen"
                - option "Lighten"
                - option "Darken"
                - option "Overlay"
                - option "Color Dodge"
                - option "Color Burn"
                - option "Difference"
                - option "Exclusion"
                - option "Hard Light"
            - generic [ref=e267]:
              - text: src + dst × (1 − src.a)
              - generic [ref=e268]: — Standard source-over compositing on premultiplied colours. Use this when you want normal layer stacking.
    - generic [ref=e269]:
      - button "🎵 Reactive Input ▶" [ref=e270]:
        - generic [ref=e271]: 🎵 Reactive Input
        - generic [ref=e272]: ▶
      - generic [ref=e273]: Audio + MIDI performance control
    - generic [ref=e274]:
      - button "🔍 Upscale ▶" [ref=e275]:
        - generic [ref=e276]: 🔍 Upscale
        - generic [ref=e277]: ▶
      - generic [ref=e278]: Real-ESRGAN / waifu2x research tools
    - generic [ref=e279]:
      - button "🧪 Diagnostics & Inspector ▶" [ref=e280]:
        - generic [ref=e281]: 🧪 Diagnostics & Inspector
        - generic [ref=e282]: ▶
      - generic [ref=e283]: Collision stats, heatmap, tracer export
    - generic [ref=e284]:
      - button "🎬 Video Export ▼" [expanded] [ref=e285]:
        - generic [ref=e286]: 🎬 Video Export
        - generic [ref=e287]: ▼
      - generic [ref=e289]:
        - text: Video Export
        - generic [ref=e290]:
          - generic [ref=e291]:
            - text: Duration (s)
            - spinbutton "Duration (s)" [ref=e292]: "5"
          - generic [ref=e293]:
            - text: FPS
            - spinbutton "FPS" [ref=e294]: "30"
        - generic [ref=e295]:
          - generic [ref=e296]:
            - text: "Scale:"
            - generic [ref=e297]: 1.00x
          - slider [ref=e298] [cursor=pointer]: "1"
        - generic [ref=e299]:
          - text: Filename
          - textbox "Filename" [ref=e300]: chromashift-export
        - generic [ref=e301]:
          - text: Pass
          - combobox "Pass" [ref=e302]:
            - option "Composite" [selected]
            - option "Tracers only"
            - option "Layers only"
        - generic [ref=e303]:
          - button "Tracers On" [ref=e304]
          - button "Preset Angles" [ref=e305]
        - generic [ref=e306]:
          - button "Export Video" [ref=e307]
          - button "Cancel" [disabled] [ref=e308]
        - generic [ref=e309]: "Codec: video/webm;codecs=vp9 · WebCodecs available"
    - generic [ref=e310]:
      - button "💾 Presets ▶" [ref=e311]:
        - generic [ref=e312]: 💾 Presets
        - generic [ref=e313]: ▶
      - generic [ref=e314]: Save, share URL, gallery
    - generic [ref=e315]:
      - button "⚙ Viewport ▶" [ref=e316]:
        - generic [ref=e317]: ⚙ Viewport
        - generic [ref=e318]: ▶
      - generic [ref=e319]: Canvas shape, MSAA, quarter zoom
```

# Test source

```ts
  1  | import type { Page } from '@playwright/test';
  2  | 
  3  | export async function waitForWebGL(page: Page, timeout = 30_000): Promise<void> {
  4  |   await page.waitForFunction(() => window.usingWebGL === true, undefined, { timeout });
  5  | }
  6  | 
  7  | export async function waitForWebGPU(page: Page, timeout = 45_000): Promise<void> {
  8  |   try {
  9  |     await page.waitForFunction(() => window.usingWebGPU === true, undefined, { timeout });
  10 |   } catch (error) {
  11 |     const diagnostics = await page.evaluate(() => ({
  12 |       rendererType: window.rendererType,
  13 |       usingWebGPU: window.usingWebGPU,
  14 |       usingWebGL: window.usingWebGL,
  15 |       rendererFallbackReason: window.rendererFallbackReason ?? null,
  16 |       hasNavigatorGpu: typeof navigator !== 'undefined' && !!navigator.gpu,
  17 |       gpuErrorVisible: document.body?.innerText?.includes('not supported') ?? false,
  18 |     }));
> 19 |     throw new Error(
     |           ^ Error: WebGPU bootstrap timed out after 45000ms: {"rendererFallbackReason":null,"hasNavigatorGpu":true,"gpuErrorVisible":true}
  20 |       `WebGPU bootstrap timed out after ${timeout}ms: ${JSON.stringify(diagnostics)}`,
  21 |       { cause: error },
  22 |     );
  23 |   }
  24 | }
  25 | 
```