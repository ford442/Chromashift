# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: live-source.spec.ts >> Live source motion field >> direction solves a flow vector, not just a magnitude
- Location: e2e/live-source.spec.ts:119:3

# Error details

```
Error: expect(received).toBeLessThan(expected)

Expected: < 1.5707963267948966
Received:   2.2541175220496257
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - status:
    - generic: WEBGL2 active
    - generic: Opt-in diagnostic renderer. WebGPU is not running this session.
  - generic [ref=e8]: Original
  - generic [ref=e11]: Separated
  - generic [ref=e14]:
    - generic [ref=e15]: Tracer
    - generic [ref=e16]:
      - button "Live" [ref=e17]
      - button "Preview On" [ref=e18]
  - button "⏸ Pause" [ref=e20]
  - generic [ref=e21]:
    - button "Browse Images" [ref=e22]
    - button "⏹ Stop Video File" [ref=e23]
  - generic [ref=e24]:
    - generic [ref=e25]: "Avg Lum (live): 91"
    - slider [disabled] [ref=e26] [cursor=pointer]: "91"
    - generic [ref=e27]: 🔷 TS
    - generic [ref=e28]: CPU 0.20 / 7.63 ms
    - generic [ref=e29]: 2+ 0 | all 0
    - generic [ref=e30]: Win 0/0/0
  - generic [ref=e31]:
    - generic [ref=e32]:
      - generic [ref=e33]: ✨ NUNIF Controls
      - generic [ref=e34]:
        - button "⏸" [ref=e35]
        - button "⟲" [ref=e36]
    - generic [ref=e38]:
      - generic [ref=e39]:
        - text: "Image:"
        - generic [ref=e40]: 5s
      - slider [ref=e41] [cursor=pointer]: "5"
    - generic [ref=e42]:
      - generic [ref=e43]: 📷 Load
      - generic [ref=e44]:
        - button "URL" [ref=e45]
        - button "File" [ref=e46]
      - button "Browse Images" [ref=e47]
    - generic [ref=e48]:
      - generic [ref=e49]: 🖼 Reference
      - generic [ref=e50]: No reference loaded
      - generic [ref=e51]:
        - button "Ref URL" [ref=e52]
        - button "Ref File" [ref=e53]
    - generic [ref=e54]:
      - button "🎛 Renderer & Engine ▼" [expanded] [ref=e55]:
        - generic [ref=e56]: 🎛 Renderer & Engine
        - generic [ref=e57]: ▼
      - generic [ref=e58]:
        - generic [ref=e59]:
          - generic [ref=e60]:
            - generic [ref=e61]:
              - generic [ref=e62]: Renderer
              - generic [ref=e63]: "Active: WEBGL"
            - generic [ref=e64]:
              - button "WEBGPU" [ref=e65]
              - button "WEBGL" [ref=e66]
          - generic [ref=e67]: WebGL is diagnostic / XR, not fallback. Failed WebGPU boots stay blocked until you open a new session.
          - generic [ref=e68]:
            - text: "WebGL debug:"
            - combobox [ref=e69]:
              - option "Composite parity" [selected]
              - option "Luminance mask"
              - option "Rotation UV grid"
              - option "Layer mask isolation"
        - generic [ref=e70]:
          - generic [ref=e71]: 🥽 WebXR (research)
          - paragraph [ref=e72]: "Phase-0 spike: immersive-vr composite via WebGL bridge at half resolution. Requires WebGL renderer; disabled in kiosk mode."
          - paragraph [ref=e73]: immersive-vr not supported
          - button "Enter immersive VR" [disabled] [ref=e74]
        - generic [ref=e75]:
          - generic [ref=e76]: ⚡ Engine
          - paragraph [ref=e77]: Load-time analysis (luminance, masks, decay). GPU rendering is unchanged.
          - generic [ref=e78]:
            - button "TS" [ref=e79]
            - button "C++ WASM" [ref=e80]
          - generic [ref=e81]: 🔷 TypeScript — load-time analysis
    - generic [ref=e82]:
      - button "🌍 Layers & Global ▼" [expanded] [ref=e83]:
        - generic [ref=e84]: 🌍 Layers & Global
        - generic [ref=e85]: ▼
      - generic [ref=e86]:
        - generic [ref=e88]:
          - generic [ref=e89]: "Layers: 3"
          - slider "Band layers (1–10). Each owns a contiguous run of the canonical bands in shared/band.json." [ref=e90] [cursor=pointer]: "3"
        - generic [ref=e91]:
          - generic [ref=e92]:
            - generic [ref=e93]: Layer 0 — Red / Orange(reverse)
            - generic [ref=e94]:
              - generic [ref=e95]:
                - generic [ref=e103]: "0"
                - generic [ref=e104]:
                  - generic [ref=e105]: Angle
                  - generic [ref=e106]: °
              - generic [ref=e107]:
                - generic [ref=e115]: "130"
                - generic [ref=e116]:
                  - generic [ref=e117]: Rate
                  - generic [ref=e118]: °
          - generic [ref=e119]:
            - generic [ref=e120]: Layer 1 — Violet / Blue
            - generic [ref=e121]:
              - generic [ref=e122]:
                - generic [ref=e130]: "0"
                - generic [ref=e131]:
                  - generic [ref=e132]: Angle
                  - generic [ref=e133]: °
              - generic [ref=e134]:
                - generic [ref=e142]: "230"
                - generic [ref=e143]:
                  - generic [ref=e144]: Rate
                  - generic [ref=e145]: °
          - generic [ref=e146]:
            - generic [ref=e147]: Layer 2 — Green / Yellow
            - generic [ref=e148]:
              - generic [ref=e149]:
                - generic [ref=e157]: "0"
                - generic [ref=e158]:
                  - generic [ref=e159]: Angle
                  - generic [ref=e160]: °
              - generic [ref=e161]:
                - generic [ref=e169]: "330"
                - generic [ref=e170]:
                  - generic [ref=e171]: Rate
                  - generic [ref=e172]: °
        - generic [ref=e173]:
          - generic [ref=e174]:
            - generic [ref=e175]: "FPS: 30"
            - slider [ref=e176] [cursor=pointer]: "30"
          - paragraph [ref=e177]: FPS samples motion only — layer Rate keeps wall-clock spin speed.
          - generic [ref=e178]:
            - generic [ref=e179]:
              - text: "Opac:"
              - generic [ref=e180]: 100%
            - slider [ref=e181] [cursor=pointer]: "1"
          - generic [ref=e182]:
            - generic [ref=e183]:
              - generic [ref=e184]:
                - text: "L0:"
                - generic [ref=e185]: 100%
              - slider [ref=e186] [cursor=pointer]: "1"
            - generic [ref=e187]:
              - generic [ref=e188]:
                - text: "L1:"
                - generic [ref=e189]: 100%
              - slider [ref=e190] [cursor=pointer]: "1"
            - generic [ref=e191]:
              - generic [ref=e192]:
                - text: "L2:"
                - generic [ref=e193]: 100%
              - slider [ref=e194] [cursor=pointer]: "1"
          - generic [ref=e195]:
            - text: "Spectrum:"
            - generic [ref=e196]:
              - button "🧱 Fixed" [ref=e197]
              - button "🌈 Vivid" [ref=e198]
              - button "🌿 CROP" [ref=e199]
              - button "📺 N2" [ref=e200]
          - generic [ref=e201]:
            - text: "Colour profile:"
            - combobox "Named colour profile — Classic keeps the original cr0p look; others re-map every band." [ref=e202]:
              - option "CR0P Classic" [selected]
              - option "Soft Gradient Revival"
              - option "Diagnostic Grey"
            - generic [ref=e203]:
              - button "⬆ Import" [ref=e204]
              - button "⬇ Export" [ref=e205]
          - generic [ref=e206]:
            - text: "Band shaping:"
            - generic [ref=e207]:
              - button "○ Sobel" [ref=e208]
              - button "≈ Soft" [ref=e209]
          - generic [ref=e210]:
            - generic [ref=e211]:
              - text: "Layer:"
              - generic [ref=e212]: 1.0x
            - slider [ref=e213] [cursor=pointer]: "1"
          - generic [ref=e214]:
            - generic [ref=e215]:
              - text: "Tracer:"
              - generic [ref=e216]: 1.0x
            - slider [ref=e217] [cursor=pointer]: "1"
    - generic [ref=e218]:
      - button "✨ Dual Tracer ▼" [expanded] [ref=e219]:
        - generic [ref=e220]: ✨ Dual Tracer
        - generic [ref=e221]: ▼
      - generic [ref=e222]:
        - generic [ref=e223]:
          - generic [ref=e224]: ⬆ Top Layer
          - generic [ref=e225]:
            - generic [ref=e226]: "Opac:"
            - slider [ref=e227] [cursor=pointer]: "0.85"
            - generic [ref=e228]: 85%
          - generic [ref=e229]:
            - generic [ref=e230]: "Hold:"
            - slider [ref=e231] [cursor=pointer]: "500"
            - generic [ref=e232]: 0.5s
        - generic [ref=e233]:
          - generic [ref=e234]: ⬇ Base Layer
          - generic [ref=e235]:
            - generic [ref=e236]: "Opac:"
            - slider [ref=e237] [cursor=pointer]: "0.3"
            - generic [ref=e238]: 30%
          - generic [ref=e239]:
            - generic [ref=e240]: "Hold:"
            - slider [ref=e241] [cursor=pointer]: "2000"
            - generic [ref=e242]: 2.0s
        - generic [ref=e243]:
          - generic [ref=e244]:
            - generic [ref=e245]: "Mode:"
            - button "🎨" [ref=e246]
          - button "🔬 Show Full Tracer" [ref=e247]
          - generic [ref=e248]:
            - text: "Main View:"
            - combobox [ref=e249]:
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
            - generic [ref=e250]: "Src: E2E Fixture"
            - generic [ref=e251]: "Ref: —"
            - generic [ref=e252]:
              - text: "Blend Overlay:"
              - combobox [ref=e253]:
                - option "Source (follows autoplay)"
                - option "Reference" [selected]
                - option "Previous"
                - option "Separated output"
            - generic [ref=e254]:
              - combobox [ref=e255]:
                - option "Hidden" [selected]
                - option "Alpha overlay"
                - option "Split"
                - option "Checker"
                - option "Difference"
                - option "Edge"
              - generic [ref=e256]:
                - generic [ref=e257]: 22%
                - slider [ref=e258] [cursor=pointer]: "0.22"
          - generic [ref=e259]:
            - text: "Composite Stack:"
            - generic [ref=e260]:
              - button "Mixed" [ref=e261]
              - button "Focus" [ref=e262]
              - button "Only" [ref=e263]
              - button "Peak" [ref=e264]
          - generic [ref=e265]:
            - button "Swap Src/Ref" [ref=e266]
            - button "Open Browser" [ref=e267]
        - generic [ref=e268]:
          - generic [ref=e269]: 🌊 Motion
          - generic [ref=e270]:
            - generic [ref=e271]: "Mode:"
            - combobox "Mode:" [ref=e272]:
              - option "Off"
              - option "Boost"
              - option "Gate"
              - option "Direction" [selected]
          - generic [ref=e273]: Flow angle drives hue; still regions keep a magnitude tint.
          - generic [ref=e274]:
            - generic [ref=e275]: "Gain:"
            - slider "Motion gain" [ref=e276] [cursor=pointer]: "1"
            - generic [ref=e277]: 1.00×
          - generic [ref=e278]:
            - generic [ref=e279]: "Hold:"
            - slider "Motion hold" [ref=e280] [cursor=pointer]: "0.5"
            - generic [ref=e281]: 50%
          - generic [ref=e282]:
            - generic [ref=e283]: "Floor:"
            - slider "Motion floor" [ref=e284] [cursor=pointer]: "0.04"
            - generic [ref=e285]: "0.040"
        - generic [ref=e286]:
          - generic [ref=e287]: 🔀 Blend
          - generic [ref=e288]:
            - generic [ref=e289]:
              - generic [ref=e290]: "Layer:"
              - combobox "Layer blend mode" [ref=e291]:
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
            - generic [ref=e292]:
              - text: src + dst × (1 − src.a)
              - generic [ref=e293]: — Standard source-over compositing on premultiplied colours. Use this when you want normal layer stacking.
          - generic [ref=e294]:
            - generic [ref=e295]:
              - generic [ref=e296]: "Tracer:"
              - combobox "Tracer blend mode" [ref=e297]:
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
            - generic [ref=e298]:
              - text: src + dst × (1 − src.a)
              - generic [ref=e299]: — Standard source-over compositing on premultiplied colours. Use this when you want normal layer stacking.
    - generic [ref=e300]:
      - button "🎵 Reactive Input ▶" [ref=e301]:
        - generic [ref=e302]: 🎵 Reactive Input
        - generic [ref=e303]: ▶
      - generic [ref=e304]: Audio + MIDI performance control
    - generic [ref=e305]:
      - button "🔍 Upscale ▶" [ref=e306]:
        - generic [ref=e307]: 🔍 Upscale
        - generic [ref=e308]: ▶
      - generic [ref=e309]: Real-ESRGAN / waifu2x research tools
    - generic [ref=e310]:
      - button "🧪 Diagnostics & Inspector ▶" [ref=e311]:
        - generic [ref=e312]: 🧪 Diagnostics & Inspector
        - generic [ref=e313]: ▶
      - generic [ref=e314]: Collision stats, heatmap, tracer export
    - generic [ref=e315]:
      - button "🎬 Video Export ▼" [expanded] [ref=e316]:
        - generic [ref=e317]: 🎬 Video Export
        - generic [ref=e318]: ▼
      - generic [ref=e320]:
        - text: Video Export
        - generic [ref=e321]:
          - generic [ref=e322]:
            - text: Duration (s)
            - spinbutton "Duration (s)" [ref=e323]: "5"
          - generic [ref=e324]:
            - text: FPS
            - spinbutton "FPS" [ref=e325]: "30"
        - generic [ref=e326]:
          - generic [ref=e327]:
            - text: "Scale:"
            - generic [ref=e328]: 1.00x
          - slider [ref=e329] [cursor=pointer]: "1"
        - generic [ref=e330]:
          - text: Filename
          - textbox "Filename" [ref=e331]: chromashift-export
        - generic [ref=e332]:
          - text: Pass
          - combobox "Pass" [ref=e333]:
            - option "Composite" [selected]
            - option "Tracers only"
            - option "Layers only"
        - generic [ref=e334]:
          - generic [ref=e335]:
            - text: Container
            - combobox "Container" [ref=e336]:
              - option "Auto" [selected]
              - option "WebM"
              - option "MP4"
          - generic [ref=e337]:
            - text: Quality
            - combobox "Quality" [ref=e338]:
              - option "High" [selected]
              - option "Medium"
              - option "Low"
        - generic [ref=e339]:
          - button "Tracers On" [ref=e340]
          - button "Preset Angles" [ref=e341]
        - generic [ref=e342]:
          - button "Export Video" [ref=e343]
          - button "Cancel" [disabled] [ref=e344]
        - generic [ref=e345]: "Encoding: WebCodecs (VP9 WebM)"
    - generic [ref=e346]:
      - button "💾 Presets ▶" [ref=e347]:
        - generic [ref=e348]: 💾 Presets
        - generic [ref=e349]: ▶
      - generic [ref=e350]: Save, share URL, gallery
    - generic [ref=e351]:
      - button "⚙ Viewport ▶" [ref=e352]:
        - generic [ref=e353]: ⚙ Viewport
        - generic [ref=e354]: ▶
      - generic [ref=e355]: Canvas shape, MSAA, quarter zoom
```

# Test source

```ts
  44  | 
  45  |     const breadcrumbs = await page.evaluate(() => ({
  46  |       active: window.liveSourceActive,
  47  |       kind: window.liveSourceKind,
  48  |     }));
  49  |     expect(breadcrumbs.active).toBe(true);
  50  |     expect(breadcrumbs.kind).toBe('video-file');
  51  | 
  52  |     const stopButton = page.getByRole('button', { name: /Stop Video File/i });
  53  |     await expect(stopButton).toBeVisible();
  54  |     await expect(page.locator('canvas').first()).toBeVisible();
  55  | 
  56  |     // Stopping releases the stream and clears the breadcrumb. Dispatched via
  57  |     // a raw DOM click (rather than Playwright's hit-testing click) because
  58  |     // the live video decode + WebGL composite keep the page busy enough that
  59  |     // pointer-event actionability polling can stall on slower CI runners.
  60  |     await stopButton.evaluate((el: HTMLElement) => el.click());
  61  |     await page.waitForFunction(() => window.liveSourceActive === false, undefined, { timeout: 15_000 });
  62  |   });
  63  | });
  64  | 
  65  | test.describe('Live source motion field', () => {
  66  |   // Each case boots the app, decodes a video, and then watches the field for
  67  |   // a second or so — comfortably past the 30s default on a slow runner.
  68  |   test.describe.configure({ timeout: 60_000 });
  69  | 
  70  |   test.beforeEach(async ({ page }) => {
  71  |     await setE2eViewport(page);
  72  |     await stubMinimalCorpus(page);
  73  |     await primeOverlaySections(page, { tracer: true });
  74  |     await page.goto('/?renderer=webgl');
  75  |     await waitForWebGL(page);
  76  |   });
  77  | 
  78  |   test('motionMode: off computes no field at all', async ({ page }) => {
  79  |     await loadVideo(page, movingVideo);
  80  | 
  81  |     // The default mode must not pay for a field it does not use, so the
  82  |     // breadcrumb stays at whatever the teardown left and the energy at zero.
  83  |     expect(await peakMotionEnergy(page, 6)).toBe(0);
  84  |     expect(await page.evaluate(() => window.motionFieldBackend ?? null)).toBeNull();
  85  |   });
  86  | 
  87  |   test('a moving fixture produces a non-zero motion breadcrumb', async ({ page }) => {
  88  |     await page.getByTestId('tracer-motion-mode').selectOption('boost');
  89  |     await loadVideo(page, movingVideo);
  90  | 
  91  |     await page.waitForFunction(
  92  |       () => (window.motionFieldEnergy ?? 0) > 0,
  93  |       undefined,
  94  |       { timeout: 20_000 },
  95  |     );
  96  | 
  97  |     // The WebGL backend has no compute lane, so this lands on the chore kit's
  98  |     // CPU lanes — `ts` unless a host supplies a WASM motion kernel.
  99  |     const backend = await page.evaluate(() => window.motionFieldBackend ?? null);
  100 |     expect(backend).toMatch(/^(ts|wasm)/);
  101 |     expect(await page.evaluate(() => window.motionFieldReason ?? null)).toBeNull();
  102 |   });
  103 | 
  104 |   test('boost solves no flow vector \u2014 magnitude is all it reads', async ({ page }) => {
  105 |     await page.getByTestId('tracer-motion-mode').selectOption('boost');
  106 |     await loadVideo(page, movingVideo);
  107 | 
  108 |     await page.waitForFunction(
  109 |       () => (window.motionFieldEnergy ?? 0) > 0,
  110 |       undefined,
  111 |       { timeout: 20_000 },
  112 |     );
  113 | 
  114 |     // Stage 2 is opt-in per mode: `boost` must keep costing exactly what it
  115 |     // cost before the Lucas-Kanade pass existed.
  116 |     expect(await page.evaluate(() => window.motionFieldHasFlow ?? null)).toBe(false);
  117 |   });
  118 | 
  119 |   test('direction solves a flow vector, not just a magnitude', async ({ page }) => {
  120 |     await page.getByTestId('tracer-motion-mode').selectOption('direction');
  121 |     await loadVideo(page, movingVideo);
  122 | 
  123 |     await page.waitForFunction(
  124 |       () => window.motionFieldHasFlow === true && (window.motionFieldFlow?.movingCells ?? 0) > 0,
  125 |       undefined,
  126 |       { timeout: 20_000 },
  127 |     );
  128 | 
  129 |     // Stage 1 wrote a zero flow vector everywhere, so `direction` could only
  130 |     // ever render a magnitude tint: `atan2(0, 0)` pins the hue. A non-zero mean
  131 |     // velocity here is the whole difference \u2014 the angle feeding that
  132 |     // `atan2` is now a solved direction, so hue follows where the subject went
  133 |     // rather than only how much it changed.
  134 |     const flow = await page.evaluate(() => window.motionFieldFlow ?? null);
  135 |     expect(flow).not.toBeNull();
  136 |     expect(flow!.meanSpeed).toBeGreaterThan(0);
  137 |     expect(Math.hypot(flow!.meanVx, flow!.meanVy)).toBeGreaterThan(0);
  138 | 
  139 |     // And the direction is a property of the scene, not of the frame it was
  140 |     // sampled on: a fixture tracking one way keeps reporting one way.
  141 |     const later = await page.evaluate(() => window.motionFieldFlow ?? null);
  142 |     const angle = (f: { meanVx: number; meanVy: number }) => Math.atan2(f.meanVy, f.meanVx);
  143 |     const delta = Math.abs(angle(flow!) - angle(later!));
> 144 |     expect(Math.min(delta, Math.PI * 2 - delta)).toBeLessThan(Math.PI / 2);
      |                                                  ^ Error: expect(received).toBeLessThan(expected)
  145 |   });
  146 | 
  147 |   test('a still fixture produces zero', async ({ page }) => {
  148 |     await page.getByTestId('tracer-motion-mode').selectOption('boost');
  149 |     await loadVideo(page, stillVideo);
  150 | 
  151 |     // Wait until a sample has actually run before believing the zero: an
  152 |     // unset breadcrumb and a genuinely motionless field both read as 0.
  153 |     await page.waitForFunction(
  154 |       () => (window.motionFieldBackend ?? null) !== null,
  155 |       undefined,
  156 |       { timeout: 20_000 },
  157 |     );
  158 | 
  159 |     expect(await peakMotionEnergy(page)).toBe(0);
  160 |   });
  161 | });
  162 | 
  163 | test.describe('Live source motion field (WebGPU, ?no_gpu_compute)', () => {
  164 |   test.describe.configure({ timeout: 90_000 });
  165 | 
  166 |   test.beforeEach(async ({ page }) => {
  167 |     await setE2eViewport(page);
  168 |     await stubMinimalCorpus(page);
  169 |     await primeOverlaySections(page, { tracer: true });
  170 |     await page.goto('/?renderer=webgpu&no_gpu_compute');
  171 |     // Headless runners without a GPU adapter can't host this case; the
  172 |     // upload/pack path is covered by `MotionFieldPass.test.ts` there.
  173 |     const hasAdapter = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
  174 |     test.skip(!hasAdapter, 'No WebGPU adapter on this runner');
  175 |     await waitForWebGPU(page);
  176 |   });
  177 | 
  178 |   test('direction falls back to the CPU lane and still solves flow', async ({ page }) => {
  179 |     await page.getByTestId('tracer-motion-mode').selectOption('direction');
  180 |     await loadVideo(page, movingVideo);
  181 | 
  182 |     // The GPU lane declines here, so the renderer adopts the sampler's CPU
  183 |     // field — the breadcrumbs name that lane, not a bare decline.
  184 |     await page.waitForFunction(
  185 |       () => window.motionFieldHasFlow === true && (window.motionFieldFlow?.movingCells ?? 0) > 0,
  186 |       undefined,
  187 |       { timeout: 30_000 },
  188 |     );
  189 |     expect(await page.evaluate(() => window.motionFieldBackend ?? null)).toMatch(/^(ts|wasm)/);
  190 |     expect(await peakMotionEnergy(page, 6)).toBeGreaterThan(0);
  191 |   });
  192 | });
  193 | 
```