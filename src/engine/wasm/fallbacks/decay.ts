/**
 * Pure TypeScript decay fallback — used when the WASM engine is unavailable or
 * `useWasm` is false. Mirrors `durationToDecay` in `cpp/chromashift_engine.cpp`.
 *
 * `durationToDecay` itself already lives in `../../math/decay.ts` (single
 * source of truth for the tracer-persistence formula) — re-exported here so
 * dispatch has one fallback import surface.
 */

export { durationToDecay } from '../../math/decay';
