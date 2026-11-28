import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

interface BuildInfo {
  sha: string
  dirty: boolean
  builtAt: string
}

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * Which commit this build is (#268). `BUILD_SHA` / `BUILD_DIRTY` override git for
 * builds without a checkout (a source tarball, a Docker layer); with neither, the
 * stamp says `unknown` and `dirty: true`, so an unidentifiable build can never
 * pass for a clean one. `dirty` counts tracked changes and untracked files that
 * are not gitignored; `dist/`, `node_modules/` and the like are ignored.
 */
function resolveBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const sha = env.BUILD_SHA?.trim() || git('rev-parse', 'HEAD') || 'unknown'
  const porcelain = git('status', '--porcelain')
  const dirty =
    env.BUILD_DIRTY !== undefined && env.BUILD_DIRTY !== ''
      ? env.BUILD_DIRTY === '1' || env.BUILD_DIRTY === 'true'
      : sha === 'unknown' || porcelain === null || porcelain !== ''
  const epoch = Number(env.SOURCE_DATE_EPOCH)
  const builtAt = (Number.isFinite(epoch) && env.SOURCE_DATE_EPOCH ? new Date(epoch * 1000) : new Date()).toISOString()
  return { sha, dirty, builtAt }
}

const buildInfo = resolveBuildInfo()

/** Writes `dist/version.json` (served beside `index.html`, so `./version.json` from the page). */
function versionJson(info: BuildInfo): Plugin {
  return {
    name: 'chromashift-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify(info, null, 2)}\n` })
    },
  }
}

/**
 * Files that live in `public/` because the dev server, the E2E specs or
 * `npm run bench:wasm` read them from there, but that a deployed app never
 * requests. They are served by `npm run dev` and left out of `dist/`;
 * `scripts/check-dist-assets.mjs` fails the build if one reappears.
 */
const DEV_ONLY_PUBLIC_FILES = ['e2e-fixture.png', 'wasm-benchmark.html', 'wasm-benchmark-core.mjs']

function dropDevOnlyPublicFiles(): Plugin {
  let outDir = 'dist'
  return {
    name: 'chromashift-drop-dev-only-public-files',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
    },
    closeBundle() {
      for (const name of DEV_ONLY_PUBLIC_FILES) rmSync(join(outDir, name), { force: true })
    },
  }
}

/**
 * The cross-origin isolation headers the production host sends (its Apache
 * config; mirrored in `public/.htaccess`). `vite preview` is what the E2E smoke
 * and local checks serve the production build with, so it has to isolate the
 * page the same way or a COEP-blocked sub-resource only shows up after deploy.
 */
const PRODUCTION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), versionJson(buildInfo), dropDevOnlyPublicFiles()],
  define: { __BUILD_INFO__: JSON.stringify(buildInfo) },
  preview: { headers: PRODUCTION_HEADERS },
  // Every `new Worker(...)` in the app is `{ type: 'module' }`, but Vite's
  // default worker output format is `iife` - so the built workers were classic
  // scripts being constructed as module ones. `es` builds them as the modules
  // they are declared to be, shares chunks with the main bundle instead of
  // duplicating them per worker, and is what makes the lazily loaded upscaler
  // workers' dynamic imports legal at all.
  worker: { format: 'es' },
  resolve: {
    conditions: [
      'onnxruntime-web-use-extern-wasm',
      'import',
      'module',
      'browser',
      'default',
    ],
  },
})
