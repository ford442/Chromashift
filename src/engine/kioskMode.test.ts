import { describe, expect, it } from 'vitest';
import { isKioskModeSearch } from './kioskMode';

describe('isKioskModeSearch', () => {
  it('accepts common truthy kiosk query values', () => {
    expect(isKioskModeSearch('?kiosk=1')).toBe(true);
    expect(isKioskModeSearch('?kiosk=true')).toBe(true);
    expect(isKioskModeSearch('?kiosk=yes')).toBe(true);
    expect(isKioskModeSearch('?kiosk=on')).toBe(true);
    expect(isKioskModeSearch('?kiosk')).toBe(true);
  });

  it('rejects absent or false kiosk flags', () => {
    expect(isKioskModeSearch('')).toBe(false);
    expect(isKioskModeSearch('?kiosk=0')).toBe(false);
    expect(isKioskModeSearch('?kiosk=false')).toBe(false);
    expect(isKioskModeSearch('?renderer=webgpu')).toBe(false);
  });
});
