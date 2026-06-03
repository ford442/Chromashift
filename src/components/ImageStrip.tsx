import type { ImageEntry } from '../engine/TextureManager';

interface Props {
  images: ImageEntry[];
  currentIndex: number;
  referenceUrl: string | null;
  isOpen: boolean;
  onToggleOpen: () => void;
  onSelectSource: (index: number) => void;
  onSelectReference: (index: number) => void;
}

function getImageLabel(image: ImageEntry, index: number): string {
  if (image.label?.trim()) return image.label.trim();
  try {
    const path = new URL(image.url, window.location.href).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return last || `Image ${index + 1}`;
  } catch {
    return image.url.split('/').filter(Boolean).pop() || `Image ${index + 1}`;
  }
}

export function ImageStrip({
  images,
  currentIndex,
  referenceUrl,
  isOpen,
  onToggleOpen,
  onSelectSource,
  onSelectReference,
}: Props) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-40 pointer-events-none">
      <div className="flex justify-center mb-2 pointer-events-auto">
        <button
          onClick={onToggleOpen}
          className="px-3 py-1 rounded-full bg-black/65 backdrop-blur-md border border-amber-500/30 text-amber-200 text-xs font-mono hover:bg-black/80 transition-colors"
        >
          {isOpen ? 'Hide Browser' : 'Browse Images'}
        </button>
      </div>

      {isOpen && (
        <div className="mx-4 mb-4 pointer-events-auto rounded-2xl border border-amber-500/20 bg-black/65 backdrop-blur-xl shadow-[0_0_50px_rgba(0,0,0,0.55)]">
          <div className="flex items-center justify-between px-4 py-2 border-b border-amber-500/15">
            <div className="text-xs font-mono text-amber-300">
              Corpus Browser
              <span className="ml-2 text-amber-200/60">{images.length} images</span>
            </div>
            <div className="text-[10px] font-mono text-amber-200/60">
              Click card = source, `Ref` = reference
            </div>
          </div>
          <div className="overflow-x-auto px-4 py-3">
            <div className="flex gap-3 min-w-max">
              {images.map((image, index) => {
                const isCurrent = index === currentIndex;
                const isReference = image.url === referenceUrl;
                return (
                  <div
                    key={`${image.url}-${index}`}
                    className={`group w-36 shrink-0 rounded-xl border overflow-hidden transition-all ${
                      isCurrent
                        ? 'border-amber-400 shadow-[0_0_18px_rgba(245,158,11,0.3)]'
                        : isReference
                          ? 'border-cyan-400 shadow-[0_0_18px_rgba(34,211,238,0.25)]'
                          : 'border-white/10'
                    }`}
                    style={{ contentVisibility: 'auto' }}
                  >
                    <button
                      onClick={() => onSelectSource(index)}
                      className="block w-full bg-zinc-900 hover:bg-zinc-800 transition-colors text-left"
                    >
                      <img
                        src={image.url}
                        alt={getImageLabel(image, index)}
                        loading="lazy"
                        className="w-full h-24 object-cover bg-black"
                        referrerPolicy="no-referrer"
                      />
                      <div className="px-2 py-1.5">
                        <div className="flex items-center gap-1 flex-wrap mb-1">
                          {isCurrent && (
                            <span className="rounded bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-mono text-black">
                              SOURCE
                            </span>
                          )}
                          {isReference && (
                            <span className="rounded bg-cyan-400/90 px-1.5 py-0.5 text-[9px] font-mono text-black">
                              REF
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-amber-100 line-clamp-2 min-h-[2rem]">
                          {getImageLabel(image, index)}
                        </div>
                      </div>
                    </button>
                    <div className="border-t border-white/10 bg-black/40 p-2">
                      <button
                        onClick={() => onSelectReference(index)}
                        className={`w-full rounded px-2 py-1 text-[10px] font-mono transition-colors ${
                          isReference
                            ? 'bg-cyan-500 text-black'
                            : 'bg-zinc-800 text-cyan-200 hover:bg-zinc-700'
                        }`}
                      >
                        {isReference ? 'Reference Active' : 'Set Reference'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
