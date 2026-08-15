import type { LiveSourceKind } from './LiveSource';

type LiveSourceWindow = Window & {
  liveSourceActive?: boolean;
  liveSourceKind?: LiveSourceKind | null;
  liveSourceFps?: number;
};

/** Publish live-source status for automation / diagnostics (see docs/LIVE_SOURCE.md). */
export function publishLiveSourceBreadcrumbs(
  active: boolean,
  kind: LiveSourceKind | null,
  fps: number,
): void {
  if (typeof window === 'undefined') return;
  const target = window as LiveSourceWindow;
  target.liveSourceActive = active;
  target.liveSourceKind = kind;
  target.liveSourceFps = fps;
}
