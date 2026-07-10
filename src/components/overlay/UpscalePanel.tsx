import type { UpscalePanelProps } from './types';

function composeSwinModel(style: string, scale: string, noise: string): string {
  const n = scale === '1' && noise === '-1' ? '0' : noise;
  return `swin_unet:${style}:${scale}:${n}`;
}

export function UpscalePanel({
  upscaleModel,
  upscaleBusy,
  upscaleProgress,
  upscaleInfo,
  onUpscaleModelChange,
  onUpscaleSource,
  onUpscaleOutput,
}: UpscalePanelProps) {
  const isSwin = upscaleModel.startsWith('swin_unet');
  const swinParts = isSwin ? upscaleModel.split(':') : [];
  const swinStyle = swinParts[1] ?? 'art';
  const swinScale = swinParts[2] ?? '2';
  const swinNoise = swinParts[3] ?? '-1';
  const selectClass = 'w-full text-xs px-2 py-1 rounded bg-zinc-800 border border-amber-500/30 text-amber-200 disabled:opacity-50';

  return (
    <div className="panel-3d space-y-2">
      <select
        value={isSwin ? `swin_unet:${swinStyle}` : upscaleModel}
        onChange={(e) => {
          const v = e.target.value;
          onUpscaleModelChange(
            v.startsWith('swin_unet') ? composeSwinModel(v.split(':')[1], swinScale, swinNoise) : v,
          );
        }}
        disabled={upscaleBusy}
        className={selectClass}
      >
        <optgroup label="Real-ESRGAN / Real-CUGAN (TF.js)">
          <option value="realesrgan:general_plus">Real-ESRGAN general_plus (4×, photo)</option>
          <option value="realesrgan:general_fast">Real-ESRGAN general_fast (4×, photo, fast)</option>
          <option value="realesrgan:anime_plus">Real-ESRGAN anime_plus (4×, anime)</option>
          <option value="realesrgan:anime_fast">Real-ESRGAN anime_fast (4×, anime, fast)</option>
          <option value="realcugan:2:conservative">Real-CUGAN 2× conservative</option>
          <option value="realcugan:4:conservative">Real-CUGAN 4× conservative</option>
        </optgroup>
        <optgroup label="waifu2x swin_unet (ONNX)">
          <option value="swin_unet:art">swin_unet art (illustration)</option>
          <option value="swin_unet:art_scan">swin_unet art_scan (scanned art)</option>
          <option value="swin_unet:photo">swin_unet photo</option>
        </optgroup>
      </select>

      {isSwin && (
        <div className="flex gap-2">
          <select
            value={swinScale}
            onChange={(e) => onUpscaleModelChange(composeSwinModel(swinStyle, e.target.value, swinNoise))}
            disabled={upscaleBusy}
            className={selectClass}
            title="Output scale"
          >
            <option value="1">1× (denoise only)</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
          </select>
          <select
            value={swinScale === '1' && swinNoise === '-1' ? '0' : swinNoise}
            onChange={(e) => onUpscaleModelChange(composeSwinModel(swinStyle, swinScale, e.target.value))}
            disabled={upscaleBusy}
            className={selectClass}
            title="Noise reduction level"
          >
            {swinScale !== '1' && <option value="-1">No denoise</option>}
            <option value="0">Denoise 0</option>
            <option value="1">Denoise 1</option>
            <option value="2">Denoise 2</option>
            <option value="3">Denoise 3</option>
          </select>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onUpscaleSource}
          disabled={upscaleBusy}
          className="flex-1 text-xs px-2 py-1 rounded bg-emerald-700/80 hover:bg-emerald-600 text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          title="Upscale the loaded image and replace the source texture. Also recomputes Avg Lum."
        >
          Upscale Source
        </button>
        <button
          type="button"
          onClick={onUpscaleOutput}
          disabled={upscaleBusy}
          className="flex-1 text-xs px-2 py-1 rounded bg-sky-700/80 hover:bg-sky-600 text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          title="Upscale the current composited output and download as PNG."
        >
          Upscale Output
        </button>
      </div>

      {upscaleBusy && (
        <div className="space-y-1">
          <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
            <div
              className="h-full bg-amber-400 transition-[width] duration-150"
              style={{ width: `${upscaleProgress}%` }}
            />
          </div>
          <div className="text-[10px] text-amber-300/80 font-mono tabular-nums">{upscaleInfo}</div>
        </div>
      )}
    </div>
  );
}
