import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ImageEntry } from '../engine/TextureManager';
import { buildCorpusIndex, filterCorpusIndex, type CorpusIndex } from '../engine/corpusIndex';

/** Card width (`w-36`) plus the `gap-3` between cards, in px. */
const TILE_WIDTH = 144;
const TILE_GAP = 12;
const TILE_STRIDE = TILE_WIDTH + TILE_GAP;

/**
 * Cards kept mounted on each side of the visible window. Small on purpose: the
 * whole point is that the DOM holds the visible window and not much else.
 */
const OVERSCAN = 3;

/**
 * How long a card must stay on screen before its thumbnail is requested.
 * Flinging the strip across thousands of entries would otherwise start (and
 * immediately abandon) a request for every card that swept past.
 */
const THUMB_SETTLE_MS = 90;

interface ThumbProps {
  src: string;
  alt: string;
  scrollRoot: HTMLElement | null;
}

/**
 * A thumbnail that only gets a `src` once its card has actually settled in the
 * viewport. `loading="lazy"` alone is the floor, not the guard: the browser
 * happily starts a lazy image the moment it is near the viewport, which during
 * a fast scroll is hundreds of them.
 */
const Thumb = memo(function Thumb({ src, alt, scrollRoot }: ThumbProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  // No IntersectionObserver (jsdom, very old browsers) means no guard to apply:
  // start armed rather than never showing a thumbnail at all.
  const [armed, setArmed] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (armed) return;
    const el = imgRef.current;
    if (!el) return;

    let timer: number | undefined;
    const cancel = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry?.isIntersecting) {
          cancel();
          timer = window.setTimeout(() => setArmed(true), THUMB_SETTLE_MS);
        } else {
          cancel();
        }
      },
      { root: scrollRoot },
    );
    observer.observe(el);

    return () => {
      cancel();
      observer.disconnect();
    };
  }, [armed, scrollRoot]);

  return (
    <img
      ref={imgRef}
      src={armed ? src : undefined}
      alt={alt}
      loading="lazy"
      decoding="async"
      data-testid="corpus-thumb"
      className="w-full h-24 object-cover bg-black"
      referrerPolicy="no-referrer"
    />
  );
});

interface CardProps {
  entry: ImageEntry;
  label: string;
  corpusIndex: number;
  isCurrent: boolean;
  isReference: boolean;
  offset: number;
  scrollRoot: HTMLElement | null;
  onSelectSource: (index: number) => void;
  onSelectReference: (index: number) => void;
}

const Card = memo(function Card({
  entry,
  label,
  corpusIndex,
  isCurrent,
  isReference,
  offset,
  scrollRoot,
  onSelectSource,
  onSelectReference,
}: CardProps) {
  return (
    <div
      data-testid="corpus-card"
      className={`absolute top-0 left-0 w-36 rounded-xl border overflow-hidden transition-colors ${
        isCurrent
          ? 'border-amber-400 shadow-[0_0_18px_rgba(245,158,11,0.3)]'
          : isReference
            ? 'border-cyan-400 shadow-[0_0_18px_rgba(34,211,238,0.25)]'
            : 'border-white/10'
      }`}
      style={{ transform: `translateX(${offset}px)` }}
    >
      <button
        onClick={() => onSelectSource(corpusIndex)}
        className="block w-full bg-zinc-900 hover:bg-zinc-800 transition-colors text-left"
      >
        <Thumb src={entry.thumbUrl ?? entry.url} alt={label} scrollRoot={scrollRoot} />
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
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-mono ${
                entry.localId ? 'bg-emerald-900/70 text-emerald-200' : 'bg-zinc-700/70 text-zinc-300'
              }`}
            >
              {entry.localId ? 'LOCAL' : 'REMOTE'}
            </span>
          </div>
          <div className="text-[11px] font-mono text-amber-100 line-clamp-2 min-h-[2rem]">
            {label}
          </div>
        </div>
      </button>
      <div className="border-t border-white/10 bg-black/40 p-2">
        <button
          onClick={() => onSelectReference(corpusIndex)}
          className={`w-full rounded px-2 py-1 text-[10px] font-mono transition-colors ${
            isReference ? 'bg-cyan-500 text-black' : 'bg-zinc-800 text-cyan-200 hover:bg-zinc-700'
          }`}
        >
          {isReference ? 'Reference Active' : 'Set Reference'}
        </button>
      </div>
    </div>
  );
});

interface VirtualCardRowProps {
  index: CorpusIndex;
  matches: readonly number[];
  currentIndex: number;
  referenceUrl: string | null;
  /**
   * The scroll element itself, not a ref: the virtualizer has to observe it from
   * a mount effect, and a child's effects run before an ancestor's ref is even
   * attached. Threading the element through state means this row re-renders the
   * moment the scroller exists, and the virtualizer picks it up then.
   */
  scrollRoot: HTMLDivElement | null;
  onSelectSource: (index: number) => void;
  onSelectReference: (index: number) => void;
}

/**
 * Owns the virtualizer, and nothing else.
 *
 * `useVirtualizer` returns fresh closures each render, so the React Compiler
 * declines to memoize any component that calls it. Keeping it in this leaf means
 * only the card row pays that price — the header, the search box and the corpus
 * index above stay compiler-optimized.
 */
const VirtualCardRow = memo(function VirtualCardRow({
  index,
  matches,
  currentIndex,
  referenceUrl,
  scrollRoot,
  onSelectSource,
  onSelectReference,
}: VirtualCardRowProps) {
  // eslint-disable-next-line react-hooks/incompatible-library -- inherent to the library; contained to this leaf
  const virtualizer = useVirtualizer({
    horizontal: true,
    count: matches.length,
    getScrollElement: () => scrollRoot,
    estimateSize: () => TILE_STRIDE,
    overscan: OVERSCAN,
  });

  return (
    <div className="relative h-[11.5rem]" style={{ width: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const corpusIndex = matches[item.index];
        const entry = index.entries[corpusIndex];
        if (!entry) return null;
        return (
          <Card
            key={corpusIndex}
            entry={entry}
            label={index.labels[corpusIndex]}
            corpusIndex={corpusIndex}
            isCurrent={corpusIndex === currentIndex}
            isReference={entry.url === referenceUrl}
            offset={item.start}
            scrollRoot={scrollRoot}
            onSelectSource={onSelectSource}
            onSelectReference={onSelectReference}
          />
        );
      })}
    </div>
  );
});

export interface CorpusBrowserProps {
  images: ImageEntry[];
  localCount: number;
  currentIndex: number;
  referenceUrl: string | null;
  onSelectSource: (index: number) => void;
  onSelectReference: (index: number) => void;
  onClearLibrary: () => void;
}

/**
 * The open corpus panel: a horizontally virtualized, searchable strip.
 *
 * Only mounted while the strip is open, so a closed browser costs nothing —
 * neither the virtualizer's observers nor the search index exist until then.
 * Indices handed to the callbacks are always *corpus* indices, never positions
 * within the current filter.
 */
export const CorpusBrowser = memo(function CorpusBrowser({
  images,
  localCount,
  currentIndex,
  referenceUrl,
  onSelectSource,
  onSelectReference,
  onClearLibrary,
}: CorpusBrowserProps) {
  const [query, setQuery] = useState('');
  // Two handles on one element: `scroller` re-renders the row once the element
  // exists (see `VirtualCardRowProps.scrollRoot`), `scrollerRef` is the one we
  // are allowed to write `scrollLeft` through.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el;
    setScroller(el);
  }, []);

  const index = useMemo(() => buildCorpusIndex(images), [images]);
  const matches = useMemo(() => filterCorpusIndex(index, query), [index, query]);

  const handleQueryChange = useCallback((next: string) => {
    setQuery(next);
    // A new filter renumbers the row, so an inherited scroll offset would land
    // the user in the middle of a result set they have not seen the start of.
    if (scrollerRef.current) scrollerRef.current.scrollLeft = 0;
  }, []);

  const handleClear = useCallback(() => {
    if (window.confirm(`Remove all ${localCount} locally-stored image(s)? This cannot be undone.`)) {
      onClearLibrary();
    }
  }, [localCount, onClearLibrary]);

  return (
    <div className="mx-4 mb-4 pointer-events-auto rounded-2xl border border-amber-500/20 bg-black/65 backdrop-blur-xl shadow-[0_0_50px_rgba(0,0,0,0.55)]">
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-amber-500/15">
        <div className="text-xs font-mono text-amber-300 shrink-0">
          Corpus Browser
          <span className="ml-2 text-amber-200/60" data-testid="corpus-count">
            {query ? `${matches.length} / ${images.length}` : `${images.length} images`}
            {localCount > 0 ? ` (${localCount} local)` : ''}
          </span>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="Filter by label…"
          aria-label="Filter corpus"
          data-testid="corpus-search"
          className="min-w-0 flex-1 max-w-xs rounded bg-black/60 border border-amber-500/25 px-2 py-1 text-[11px] font-mono text-amber-100 placeholder:text-amber-200/35 focus:outline-none focus:border-amber-400/60"
        />
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-[10px] font-mono text-amber-200/60">
            Click card = source, `Ref` = reference. Drag images/folders in to add.
          </div>
          {localCount > 0 && (
            <button
              onClick={handleClear}
              className="rounded px-2 py-1 text-[10px] font-mono bg-red-900/60 text-red-200 hover:bg-red-800/80 transition-colors"
              title="Delete every local (drag-dropped) image from this browser's storage"
            >
              Clear Library
            </button>
          )}
        </div>
      </div>
      <div ref={attachScroller} className="overflow-x-auto overflow-y-hidden px-4 py-3" data-testid="corpus-scroller">
        {matches.length === 0 ? (
          <div className="h-[11.5rem] flex items-center text-[11px] font-mono text-amber-200/50">
            {query ? `No images match “${query}”.` : 'No images loaded yet.'}
          </div>
        ) : (
          <VirtualCardRow
            index={index}
            matches={matches}
            currentIndex={currentIndex}
            referenceUrl={referenceUrl}
            scrollRoot={scroller}
            onSelectSource={onSelectSource}
            onSelectReference={onSelectReference}
          />
        )}
      </div>
    </div>
  );
});
