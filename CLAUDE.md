# Chromashift — Claude Code Guide

**[AGENTS.md](AGENTS.md) is the canonical project/architecture guide — read it first.**
This file only adds notes specific to working in Claude Code; it intentionally does not
duplicate architecture, feature, or pipeline descriptions to avoid drifting out of sync
with AGENTS.md again (see issue #89). If anything below ever contradicts AGENTS.md,
AGENTS.md wins.

## Common Commands

```bash
npm run dev       # Start Vite dev server (http://localhost:5173)
npm run build     # Type-check with tsc then build to dist/
npm run lint      # ESLint (flat config, v9+)
npm run knip      # Unused files, exports and dependencies (knip.json)
npm test          # Vitest: node project (*.test.ts) + happy-dom project (*.dom.test.tsx)
npm run test:coverage  # The same with v8 coverage (coverage/, gitignored)
npm run shaders:validate  # naga + glslangValidator over every shader variant (needs naga-cli, glslang)
npm run test:e2e  # Playwright smoke (WebGL)
npm run test:gpu  # Vitest `gpu` project: Dawn in Node, pixel goldens (needs a Vulkan driver; docs/HEADLESS.md)
npm run test:cpp  # C++ host tests (:werror is the CI gate, :asan is opt-in, :simd needs emsdk)
npm run compile-commands  # cpp/compile_commands.json for clangd (gitignored)
npm run preview   # Preview the production build locally
```

Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md). Testing detail: [AGENTS.md](AGENTS.md#testing-strategy).

## Key Dependency Constraint

`@tailwindcss/vite` v4 supports **vite `^5-7` only** — do **not** upgrade vite to v8 or higher until Tailwind's Vite plugin publishes support for it. Similarly, `@vitejs/plugin-react` v5 is required for Vite 7 compatibility; v6 requires Vite 8.

`package.json` `overrides` pins `@webgpu/types` to our own version: `@tensorflow/tfjs-core` depends on 0.1.38, and with two copies TypeScript resolves the *older* global WebGPU types. Keep the override until TF.js is gone (#206).

## TypeScript Config Notes

Four project references are used:

- `tsconfig.app.json` — compiles `src/` except `src/headless/`, includes `vite/client` and `@webgpu/types`
- `tsconfig.headless.json` — compiles `src/headless/` (the Node-only renderer and CLI) with `@types/node` added
- `tsconfig.node.json` — compiles `vite.config.ts` and `vitest.config.ts`, includes `@types/node`
- `tsconfig.e2e.json` — type-checks `e2e/` against the app's types (breadcrumbs come from `src/engine/diagnostics.ts`)

All use strict mode. `skipLibCheck: true` avoids noise from `.d.ts` files in `node_modules`.

## Verifying changes to the lazy-loaded upscaler workers

After touching `src/engine/upscale/Upscaler.ts`, `upscaler.worker.ts`, or `nunif.worker.ts`, run
`npm run build` (includes `check:dist`) — `dist/assets/index-*.js` must contain no
`tfjs`/`ort-wasm` references, and `dist/` must contain no `ort-wasm*.wasm`. Worker
chunks load on demand when the user clicks Upscale. See AGENTS.md's "Upscaler
(lazy-loaded)" section for why.
