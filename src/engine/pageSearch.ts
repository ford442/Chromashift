/**
 * The page's query string, wherever engine code runs.
 *
 * A few engine switches are URL flags (`?no_gpu_compute`). On the page they
 * are `window.location.search`; in the render worker `location` is the
 * worker script's URL, so the page hands its query over at boot
 * (`RenderBootRequest.pageSearch`) and this module answers with it. In Node
 * (the headless renderer, Vitest) there is no query at all.
 */

let adopted: string | null = null;

/** Worker side: the page's `location.search`, from the boot request. */
export function adoptPageSearch(search: string): void {
  adopted = search;
}

export function pageSearchParams(): URLSearchParams {
  if (adopted !== null) return new URLSearchParams(adopted);
  try {
    if (typeof window !== 'undefined') return new URLSearchParams(window.location.search);
  } catch {
    // A malformed URL reads as no flags.
  }
  return new URLSearchParams();
}
