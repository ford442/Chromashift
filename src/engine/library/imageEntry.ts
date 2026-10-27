/** One image the app can show: a corpus URL, or a drag-dropped local upload. */
export interface ImageEntry {
  url: string;
  label?: string;
  /** Present when this entry lives in the local IndexedDB library (drag-dropped upload). */
  localId?: string;
  /** Small thumbnail object URL to show in the image strip instead of decoding the full image. */
  thumbUrl?: string;
}

