import { describe, expect, it } from 'vitest';
import {
  INTERNAL_COLOR_FORMAT_HDR,
  INTERNAL_COLOR_FORMAT_LDR,
  selectInternalColorFormat,
  internalColorFormatBytesPerPixel,
} from './gpuOptions';

function mockDevice(features: GPUFeatureName[]): Pick<GPUDevice, 'features'> {
  return { features: new Set(features) } as unknown as Pick<GPUDevice, 'features'>;
}

describe('selectInternalColorFormat', () => {
  it('selects rg11b10ufloat only when rg11b10ufloat-renderable is granted', () => {
    expect(selectInternalColorFormat(mockDevice(['rg11b10ufloat-renderable']))).toBe(
      INTERNAL_COLOR_FORMAT_HDR,
    );
  });

  it('falls back to rgba8unorm when the HDR renderable feature is missing', () => {
    expect(selectInternalColorFormat(mockDevice([]))).toBe(INTERNAL_COLOR_FORMAT_LDR);
    expect(selectInternalColorFormat(mockDevice(['timestamp-query']))).toBe(INTERNAL_COLOR_FORMAT_LDR);
  });

  it('does not use rgba16float / float32-filterable as a silent middle tier', () => {
    expect(selectInternalColorFormat(mockDevice(['float32-filterable' as GPUFeatureName]))).toBe(
      INTERNAL_COLOR_FORMAT_LDR,
    );
  });
});

describe('internalColorFormatBytesPerPixel', () => {
  it('counts 4 bytes for LDR and packed HDR, 8 for rgba16float', () => {
    expect(internalColorFormatBytesPerPixel('rgba8unorm')).toBe(4);
    expect(internalColorFormatBytesPerPixel('rg11b10ufloat')).toBe(4);
    expect(internalColorFormatBytesPerPixel('rgba16float')).toBe(8);
  });
});
