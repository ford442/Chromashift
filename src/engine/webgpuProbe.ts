/**
 * WebGPU boot probe.
 *
 * For this development phase **WebGPU is required**. Chromashift no longer
 * falls back to WebGL2 when adapter/device init fails: a silent
 * `WebGPU → WebGL` slide made "works in Chrome, not Edge" look like a
 * visual-parity bug instead of the device/init bug it actually is.
 *
 * This module is the single pre-flight check `useAppWebGPUInit` runs before
 * touching `RendererOrchestrator` on the **default WebGPU** boot path. Explicit
 * `?renderer=webgl` sessions skip the probe entirely so no adapter/device is
 * requested. The probe stops **before** `requestDevice()`: the real bootstrap
 * owns the one and only device request, so a successful probe followed by a
 * real boot performs exactly one `requestDevice()`. Device- and context-stage
 * outcomes are folded back into the same published breadcrumb by
 * `recordProbeStageFailure` / `recordProbeSuccess`.
 *
 * Automatic `WebGPU → WebGL` fallback is never used — see
 * `docs/webgl-fallback.md`.
 */

import { readAdapterInfo } from './gpuBootstrap';

/** How far boot got before it stopped. */
export type WebGpuProbeStage =
  | 'secure-context'
  | 'navigator-gpu'
  | 'adapter'
  | 'device'
  | 'context'
  | 'ok';

export interface WebGpuProbeAdapter {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export interface WebGpuProbeLimits {
  maxTextureDimension2D: number;
  maxBufferSize: number;
  maxComputeInvocationsPerWorkgroup: number;
  maxStorageBufferBindingSize: number;
}

export interface WebGpuProbeResult {
  ok: boolean;
  /** Browser brand + version, so a Chrome/Edge split is legible in one line. */
  browser: string;
  /** Failure stage; `'ok'` on success. */
  stage: WebGpuProbeStage;
  /** Human-readable failure reason; `null` on success. */
  reason: string | null;
  /** Adapter identity, or `null` when no adapter was obtained. */
  adapter: WebGpuProbeAdapter | null;
  features: string[];
  limits: WebGpuProbeLimits | null;
}

interface UserAgentBrand {
  brand: string;
  version: string;
}

/**
 * Chrome and Edge share an engine and a UA string prefix, so prefer
 * `userAgentData.brands` (which names them distinctly) and fall back to a
 * targeted UA sniff.
 */
export function detectBrowserBrand(): string {
  if (typeof navigator === 'undefined') return 'unknown';

  const brands = (navigator as Navigator & {
    userAgentData?: { brands?: UserAgentBrand[] };
  }).userAgentData?.brands;

  if (Array.isArray(brands) && brands.length > 0) {
    // Skip the deliberate "Not)A;Brand" GREASE entries.
    const real = brands.filter((b) => !/not.?a.?brand/i.test(b.brand));
    const preferred = real.find((b) => /edge/i.test(b.brand))
      ?? real.find((b) => !/chromium/i.test(b.brand))
      ?? real[0];
    if (preferred) return `${preferred.brand} ${preferred.version}`;
  }

  // Order matters: Edge and Opera UA strings also contain "Chrome/", so the
  // derivative tokens must be tested first or Edge reports itself as Chrome —
  // which would defeat the point of this probe.
  const ua = navigator.userAgent ?? '';
  const tokens: [RegExp, string][] = [
    [/\bEdg(?:e|A|iOS)?\/([\d.]+)/, 'Edge'],
    [/\bOPR\/([\d.]+)/, 'Opera'],
    [/\bFirefox\/([\d.]+)/, 'Firefox'],
    [/\bChrome\/([\d.]+)/, 'Chrome'],
    [/\bVersion\/([\d.]+).*\bSafari\//, 'Safari'],
  ];
  for (const [pattern, name] of tokens) {
    const match = pattern.exec(ua);
    if (match) return `${name} ${match[1]}`;
  }
  return ua || 'unknown';
}

function emptyResult(stage: WebGpuProbeStage, reason: string | null): WebGpuProbeResult {
  return {
    ok: stage === 'ok',
    browser: detectBrowserBrand(),
    stage,
    reason,
    adapter: null,
    features: [],
    limits: null,
  };
}

/** Publish `window.webgpuProbe` + `window.usingWebGPU` for automation. */
export function publishWebGpuProbe(result: WebGpuProbeResult): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & {
    webgpuProbe?: WebGpuProbeResult;
    usingWebGPU?: boolean;
  };
  w.webgpuProbe = result;
  w.usingWebGPU = result.ok;
}

/**
 * Pre-flight WebGPU support, stopping before `requestDevice()`.
 *
 * Returns (never throws) so the caller can render a blocking error screen
 * with the reason rather than an unhandled rejection.
 */
export async function probeWebGPU(): Promise<WebGpuProbeResult> {
  if (typeof navigator === 'undefined') {
    return emptyResult('navigator-gpu', 'No navigator (non-browser environment).');
  }

  // WebGPU is gated on secure context; this is the single most common
  // "works locally, fails on the LAN box" cause.
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return emptyResult(
      'secure-context',
      'WebGPU requires a secure context (https:// or localhost).',
    );
  }

  if (!navigator.gpu) {
    return emptyResult(
      'navigator-gpu',
      'navigator.gpu is unavailable — this browser build does not expose WebGPU.',
    );
  }

  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      ?? await navigator.gpu.requestAdapter();
  } catch (error) {
    return emptyResult(
      'adapter',
      `requestAdapter() threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!adapter) {
    return emptyResult(
      'adapter',
      'No WebGPU adapter found — the browser exposes WebGPU but no GPU was offered.',
    );
  }

  let adapterFields: WebGpuProbeAdapter = {
    vendor: 'unknown',
    architecture: 'unknown',
    device: 'unknown',
    description: 'unknown',
  };
  try {
    const info = await readAdapterInfo(adapter);
    adapterFields = {
      vendor: info.vendor || 'unknown',
      architecture: info.architecture || 'unknown',
      device: info.device || 'unknown',
      description: info.description || 'unknown',
    };
  } catch {
    // Adapter info is diagnostic only — never fail the probe on it.
  }

  const limits = adapter.limits;
  return {
    ok: true,
    browser: detectBrowserBrand(),
    stage: 'ok',
    reason: null,
    adapter: adapterFields,
    features: [...adapter.features],
    limits: {
      maxTextureDimension2D: limits?.maxTextureDimension2D ?? 0,
      maxBufferSize: limits?.maxBufferSize ?? 0,
      maxComputeInvocationsPerWorkgroup: limits?.maxComputeInvocationsPerWorkgroup ?? 0,
      maxStorageBufferBindingSize: limits?.maxStorageBufferBindingSize ?? 0,
    },
  };
}

/**
 * Fold a later-stage failure (device request, canvas context, pipeline
 * creation) into an already-successful probe, so `window.webgpuProbe` always
 * describes how far boot actually got.
 */
export function recordProbeStageFailure(
  probe: WebGpuProbeResult,
  stage: WebGpuProbeStage,
  reason: string,
): WebGpuProbeResult {
  const updated: WebGpuProbeResult = { ...probe, ok: false, stage, reason };
  publishWebGpuProbe(updated);
  return updated;
}

/** Mark boot fully successful (device + swapchain are live). */
export function recordProbeSuccess(probe: WebGpuProbeResult): WebGpuProbeResult {
  const updated: WebGpuProbeResult = { ...probe, ok: true, stage: 'ok', reason: null };
  publishWebGpuProbe(updated);
  return updated;
}

/** Blocking-error payload built from a failed probe. */
export function probeFailureMessage(probe: WebGpuProbeResult): { message: string; detail: string } {
  const adapter = probe.adapter
    ? `${probe.adapter.vendor} / ${probe.adapter.architecture} / ${probe.adapter.device}`
    : 'no adapter';
  return {
    message: 'WebGPU is required and failed to initialize.',
    detail: `[${probe.stage}] ${probe.reason ?? 'Unknown failure.'} `
      + `Browser: ${probe.browser}. Adapter: ${adapter}.`,
  };
}
