export const KIOSK_URL_PARAM = 'kiosk';

/** True when `?kiosk=1`, `?kiosk=true`, or `?kiosk` is present. */
export function isKioskModeSearch(search: string): boolean {
  try {
    const value = new URLSearchParams(search).get(KIOSK_URL_PARAM);
    if (value === null) return false;
    if (value === '') return true;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
  } catch {
    return false;
  }
}

export function publishKioskBreadcrumbs(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  (window as Window & { kioskMode?: boolean }).kioskMode = enabled;
}
