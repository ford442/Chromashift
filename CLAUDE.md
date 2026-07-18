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
npm test          # Vitest unit tests
npm run test:e2e  # Playwright smoke (WebGL)
npm run test:cpp  # C++ host tests
npm run preview   # Preview the production build locally
```

Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md). Testing detail: [AGENTS.md](AGENTS.md#testing-strategy).

## Key Dependency Constraint

`@tailwindcss/vite` v4 supports **vite `^5-7` only** — do **not** upgrade vite to v8 or higher until Tailwind's Vite plugin publishes support for it. Similarly, `@vitejs/plugin-react` v5 is required for Vite 7 compatibility; v6 requires Vite 8.

## TypeScript Config Notes

Two project references are used:

- `tsconfig.app.json` — compiles `src/`, includes `vite/client` and `@webgpu/types`
- `tsconfig.node.json` — compiles `vite.config.ts`, includes `@types/node`

Both use strict mode. `skipLibCheck: true` avoids noise from `.d.ts` files in `node_modules`.

## Verifying changes to the lazy-loaded upscaler workers

After touching `src/engine/Upscaler.ts`, `upscaler.worker.ts`, or `nunif.worker.ts`, run
`npm run build` and confirm `dist/assets/index-*.js` contains no `tfjs`/`ort-wasm`
references — those should only appear in the separate worker chunks, fetched on demand
when the user clicks Upscale. See AGENTS.md's "Upscaler (lazy-loaded)" section for why.
