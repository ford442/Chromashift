import type { CompareLayoutMode } from './compareViews';

type CompareWindow = Window & {
  compareLayout?: CompareLayoutMode;
  compareSwipePosition?: number;
};

export function publishCompareBreadcrumbs(
  layout: CompareLayoutMode,
  swipePosition: number,
): void {
  if (typeof window === 'undefined') return;
  const target = window as CompareWindow;
  target.compareLayout = layout;
  target.compareSwipePosition = swipePosition;
}
