#!/usr/bin/env node
/**
 * The headless renderer's command line — `chromashift render | still | golden`
 * (docs/HEADLESS.md).
 *
 * The engine is TypeScript a browser gets through Vite, so this runs it the
 * same way: Vite's SSR module loader transforms `src/headless/cli.ts` and what
 * it imports on demand. No build step, and what renders is the code in the
 * tree. Node-only packages (Dawn's `webgpu`, `sharp`) load as ordinary
 * externals.
 */
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: {
    // As in vitest.config.ts: wgsl_reflect's `main` is a CommonJS build inside
    // a `"type": "module"` package, which Node refuses to load.
    alias: [{ find: /^wgsl_reflect$/, replacement: 'wgsl_reflect/wgsl_reflect.module.js' }],
  },
});

let code = 1;
try {
  const { main } = await server.ssrLoadModule('/src/headless/cli.ts');
  code = await main(process.argv.slice(2));
} catch (error) {
  console.error(error);
} finally {
  await server.close();
}
process.exit(code);
