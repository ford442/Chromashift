# Release smoke suite

One command proves that a **built** app works in a browser — against `vite preview`
over `dist/`, or against a deployed site — with a clean console and a clean network:

```bash
npm run build
npm run release:smoke                                   # vite preview over dist/ (starts and stops the server)
npm run release:smoke -- https://test.1ink.us/chromashift-staging/ --sha <40-hex commit>
```

It exits non-zero if any scenario fails. No server is started for a remote URL.
Options (`scripts/release-smoke.mjs`):

| Option | Meaning |
|---|---|
| `<base-url>` | The site under test. Omitted: `vite preview` over `dist/`. |
| `--sha <sha>` | The commit the live `version.json` must report (default: `dist/version.json` locally, else `git rev-parse HEAD`). `--no-sha` skips it. |
| `--stub-corpus` | Answer the remote corpus images (`cr0p.1ink.us`) locally. The PR job uses it; a deployed run exercises the real host. |
| `--allow-dirty` | Accept `dirty: true` in `version.json` (a local build of a working tree; never for staging or a release). |
| `--project <name>` | `release-webgpu`, `release-webgl`, `release-upscale` (repeatable). Default: webgpu + webgl. `release-upscale` downloads real models and runs them on the CPU — minutes per model — so it is opt-in. |
| `--out <dir>` | Results directory (default `release-results/`, gitignored). |
| `--report` | Write the State of the App report afterwards (below). |
| `-- <args>` | Passed to `playwright test` (a spec file, `-g <title>`, `--workers`). |

`PW_*`-style environment variables are not used: the suite reads `RELEASE_URL`,
`RELEASE_SHA`, `RELEASE_STUB_CORPUS`, `RELEASE_ALLOW_DIRTY` and `RELEASE_OUT`, which the
wrapper sets. `playwright.release.config.ts` is the config; `e2e/release/` the specs.

## The gate

Every scenario runs behind `e2e/release/gate.ts`. It fails the test on:

- any `console.error` — from the page, a worker, or a further tab;
- any uncaught page error;
- any failed request (`net::ERR_ABORTED` is the app cancelling its own request and is
  only counted);
- any HTTP status >= 400;
- any redirect (3xx other than a 304 revalidation) — the live server answers a missing
  file with a **302** to an off-site 404 page, so a status check alone misses a missing asset.

Warnings are recorded, not failed. A scenario that provokes one of these on purpose says
so — `gate.allow({ kind, match, reason })` — and the **reason is required**. Allowances
are per scenario, never global, and each run's summary (`release-results/gate/*.json`)
lists them used or not.

## Scenarios (`e2e/release/`)

Each runs in the WebGPU project and, where the WebGL diagnostic backend supports it, the
WebGL project. A scenario asserts a visible outcome, not just that nothing threw: a canvas
that is lit and not flat (WebGPU is read from the renderer's presentation texture, since a
headless screenshot of a WebGPU canvas can be black whatever was drawn), a changed
position, a download that decodes.

| Spec | Flows |
|---|---|
| `boot.spec.ts` | `version.json` is the expected clean commit and the page publishes the same stamp · WebGPU boot and `?renderer=webgl` boot, breadcrumbs, a drawn frame · the no-adapter screen, never starting WebGL by itself, and its two buttons (Reload page, Open WebGL diagnostic session) *(WebGPU only)* |
| `images.spec.ts` | Corpus image load, previous / next / random · corpus browser open, filter, select · a dropped local file · `?img=<url>` |
| `controls.spec.ts` | Pause / resume · layer count · a gallery preset · the shareable preset URL round trip (Copy URL → open elsewhere) · an unreadable `?preset=` is reported |
| `compare.spec.ts` | Dual, swipe, quad *(WebGPU only: the WebGL backend is single-view)* |
| `export.spec.ts` | Video export downloads a WebM that decodes in a browser to a lit frame |
| `live.spec.ts` | Video file as the live source · a camera (Chromium's fake device) |
| `kiosk.spec.ts` | `?kiosk=1` hides the chrome, Esc restores it |
| `resilience.spec.ts` | Device loss → Retry GPU *(WebGPU only)* · reload with a warm cache |
| `wasm.spec.ts` | The C++ engine loads on the page, in `analysis.worker` and in `motion.worker`; `.wasm` served as WebAssembly |
| `upscale.spec.ts` | Every model the Upscale panel offers completes a real upscale; a forced failure shows an error in the panel *(`release-upscale` project)* |

Not automatable, and written up by hand in the report's manual section: WebXR (a headset),
a real camera, a real GPU's frame pacing.

## The State of the App report

```bash
npm run release:smoke -- https://test.1ink.us/chromashift-staging/ --sha "$SHA" \
  --project release-webgpu --project release-webgl --project release-upscale --report
# or, from an existing run:
npm run release:report -- --results release-results --url https://test.1ink.us/chromashift-staging/ \
  --build --clean --suite "Unit|npm test|vitest.json" --manual manual.md --known known.md
```

`scripts/state-of-the-app.mjs` writes `release-results/report/report.md` with the sections
the release issues ask for — header (date, full SHA, URL, the live `version.json` and
whether it matches), fresh production build (command, exit code, duration, warnings, a
file / bytes / gzip table), test results, a console-and-network table per scenario,
screenshots captioned with URL, viewport, renderer and browser/GPU, known issues and a
verdict — and copies the screenshots beside it. `--build --clean` runs the release gate
(a): `rm -rf node_modules dist && npm ci && npm run build`. Its verdict is `ready` only if
every suite passed, the gate caught nothing and the live `version.json` is the expected
clean commit; a run against `localhost` is never ready.

Screenshots are of the URL the run targeted. Attach them in the issue, or push
`release-results/report/screenshots/` to an orphan `release-evidence` branch under
`issue-<n>/` and pass `--screenshot-base <raw URL prefix>`.

## In CI

- **`release-smoke` (ci.yml)**, every PR and push: builds, then
  `npm run release:smoke -- --stub-corpus` against `vite preview`, WebGPU (SwiftShader) and
  WebGL. Results are the `release-results` artifact.
- **Deploy workflow**, after the live-site verification: the same suite against the URL
  just deployed (`--sha $GITHUB_SHA`, real corpus host), plus the upscalers on staging,
  and the generated report as an artifact.

## What breaking the build looks like

The suite is only worth something if it fails when the build is broken. Two checks, run
by hand against a copy of `dist/` (outputs in the pull request):

1. **Remove a worker chunk** (`rm dist/assets/render.worker-*.js`) → the page requests a
   file that is no longer there; the gate fails the boot scenarios with an HTTP error /
   console error.
2. **Add a `console.error`** to the built entry chunk → every scenario fails with
   `[console-error] …`.
