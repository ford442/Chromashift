import type { LiveSourceKind } from './LiveSource';
import { publishDiagnostics } from '../diagnostics';

/** Publish live-source status for automation / diagnostics (see docs/LIVE_SOURCE.md). */
export function publishLiveSourceBreadcrumbs(
  active: boolean,
  kind: LiveSourceKind | null,
  fps: number,
): void {
  publishDiagnostics({ liveSourceActive: active, liveSourceKind: kind, liveSourceFps: fps });
}
