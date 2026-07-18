import type { RendererPanelProps } from './types';

export function RendererPanel({
  rendererBackend,
  rendererFallbackReason,
  webglDebugMode,
  onRendererBackendChange,
  onWebglDebugModeChange,
  engineMode,
  wasmAvailable,
  onEngineModeChange,
  xrAvailable,
  xrReason,
  xrImmersive,
  xrBusy,
  xrError,
  xrEnterAllowed,
  kioskEnabled,
  onEnterXr,
  onExitXr,
}: RendererPanelProps) {
  return (
    <div className="space-y-3">
      <div className="panel-3d space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[10px] text-amber-300 font-mono uppercase tracking-wider">Renderer</div>
            <div className="text-[10px] text-amber-100/70 font-mono">
              Active:{' '}
              <span className={rendererBackend === 'webgl' ? 'text-cyan-300' : 'text-emerald-300'}>
                {rendererBackend.toUpperCase()}
              </span>
            </div>
          </div>
          <div className="flex gap-1">
            {(['webgpu', 'webgl'] as const).map((backend) => (
              <button
                key={backend}
                type="button"
                onClick={() => onRendererBackendChange(backend)}
                className={`text-[10px] px-2 py-1 rounded font-mono transition-all ${
                  rendererBackend === backend
                    ? 'bg-amber-600 text-white shadow-[0_0_10px_rgba(245,158,11,0.35)]'
                    : 'bg-zinc-800 border border-amber-500/30 hover:bg-zinc-700 text-amber-100'
                }`}
                title={`Persist ${backend.toUpperCase()} and reload with ?renderer=${backend}`}
              >
                {backend.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        {rendererFallbackReason && (
          <div className="text-[10px] leading-snug text-cyan-200/75 font-mono">
            WebGPU fallback: {rendererFallbackReason}
          </div>
        )}
        {rendererBackend === 'webgl' && (
          <div className="space-y-1">
            <span className="text-xs text-cyan-300/90 font-mono">WebGL debug:</span>
            <select
              value={webglDebugMode}
              onChange={(event) => onWebglDebugModeChange(Number(event.target.value))}
              className="w-full text-xs px-2 py-1 rounded bg-zinc-800 border border-cyan-500/30 text-cyan-100"
            >
              <option value={0}>Composite parity</option>
              <option value={1}>Luminance mask</option>
              <option value={2}>Rotation UV grid</option>
              <option value={3}>Layer mask isolation</option>
            </select>
          </div>
        )}
      </div>

      <div className="panel-3d space-y-2">
        <div className="section-header">🥽 WebXR (research)</div>
        <p className="text-[10px] text-amber-100/60 font-mono leading-snug">
          Phase-0 spike: immersive-vr composite via WebGL bridge at half resolution.
          Requires WebGL renderer; disabled in kiosk mode.
        </p>
        {kioskEnabled && (
          <p className="text-[10px] text-cyan-200/70 font-mono">Unavailable while kiosk mode is on.</p>
        )}
        {!kioskEnabled && rendererBackend !== 'webgl' && (
          <p className="text-[10px] text-cyan-200/70 font-mono">Switch to WebGL to try XR.</p>
        )}
        {!kioskEnabled && rendererBackend === 'webgl' && !xrAvailable && (
          <p className="text-[10px] text-zinc-400 font-mono">
            {xrReason ?? 'WebXR immersive-vr not available on this device.'}
          </p>
        )}
        {xrError && (
          <p className="text-[10px] text-red-300/90 font-mono">{xrError}</p>
        )}
        <button
          type="button"
          disabled={xrBusy || (!xrImmersive && !xrEnterAllowed)}
          onClick={() => { void (xrImmersive ? onExitXr() : onEnterXr()); }}
          className={`w-full text-xs px-3 py-2 rounded font-mono transition-all ${
            xrImmersive
              ? 'bg-cyan-700 hover:bg-cyan-600 text-white'
              : 'bg-zinc-800 hover:bg-zinc-700 border border-cyan-500/40 text-cyan-100 disabled:opacity-40'
          }`}
        >
          {xrBusy ? 'Starting XR…' : xrImmersive ? 'Exit immersive VR' : 'Enter immersive VR'}
        </button>
      </div>

      <div className="panel-3d space-y-2">
        <div className="section-header">⚡ Engine</div>
        <p className="text-[9px] text-zinc-500 leading-tight">
          Load-time analysis (luminance, masks, decay). GPU rendering is unchanged.
        </p>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onEngineModeChange('ts')}
            className={`flex-1 text-xs px-2 py-1 rounded transition-all ${
              engineMode === 'ts'
                ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-amber-300/70'
            }`}
            title="Use the TypeScript engine (always available)"
          >
            TS
          </button>
          <button
            type="button"
            onClick={() => onEngineModeChange('wasm')}
            disabled={!wasmAvailable}
            className={`flex-1 text-xs px-2 py-1 rounded transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
              engineMode === 'wasm'
                ? 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-[0_0_8px_rgba(6,182,212,0.4)]'
                : 'bg-zinc-800 hover:bg-zinc-700 border border-amber-500/30 text-amber-300/70'
            }`}
            title={wasmAvailable ? 'Use C++ WASM for load-time analysis (luminance, masks)' : 'C++ WASM engine not built — run: npm run build:wasm'}
          >
            C++ WASM
          </button>
        </div>
        <div
          className={`text-[10px] font-mono text-center py-0.5 rounded ${
            engineMode === 'wasm' && wasmAvailable
              ? 'text-cyan-300 bg-cyan-900/30 border border-cyan-500/30'
              : 'text-amber-400/60'
          }`}
        >
          {engineMode === 'wasm' && wasmAvailable
            ? '⚡ C++ WASM — load-time analysis'
            : engineMode === 'wasm' && !wasmAvailable
              ? '⚠ WASM unavailable — using TS'
              : '🔷 TypeScript — load-time analysis'}
        </div>
        {!wasmAvailable && (
          <div className="text-[9px] text-zinc-500 font-mono leading-tight">
            Build WASM: <span className="text-zinc-400">npm run build:wasm</span>
          </div>
        )}
      </div>
    </div>
  );
}
