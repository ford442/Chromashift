import type { CompareLayoutMode } from './compareViews';
import { publishDiagnostics } from './diagnostics';

export function publishCompareBreadcrumbs(
  layout: CompareLayoutMode,
  swipePosition: number,
): void {
  publishDiagnostics({ compareLayout: layout, compareSwipePosition: swipePosition });
}
