import { describe, expect, it } from 'vitest';
import {
  estimateRgba8MipChainBytes,
  estimateRgba8SingleLevelBytes,
  estimateWebGlTextureBytes,
  isBlobTextureUrl,
  TEXTURE_CACHE_BYTE_BUDGET,
  TEXTURE_CACHE_MAX_ENTRIES,
  TextureCacheTracker,
} from './textureCachePolicy';

describe('textureCachePolicy', () => {
  describe('byte estimators', () => {
    it('sums mip levels for full chains', () => {
      expect(estimateRgba8MipChainBytes(4, 4)).toBe(4 * 4 * 4 + 2 * 2 * 4 + 1 * 1 * 4);
      expect(estimateRgba8MipChainBytes(1, 1)).toBe(4);
    });

    it('single-level estimate matches w×h×4', () => {
      expect(estimateRgba8SingleLevelBytes(1920, 1080)).toBe(1920 * 1080 * 4);
    });

    it('WebGL PO2 uses mip chain; non-PO2 uses single level', () => {
      expect(estimateWebGlTextureBytes(256, 256)).toBe(estimateRgba8MipChainBytes(256, 256));
      expect(estimateWebGlTextureBytes(1920, 1080)).toBe(estimateRgba8SingleLevelBytes(1920, 1080));
    });
  });

  describe('isBlobTextureUrl', () => {
    it('detects blob object URLs', () => {
      expect(isBlobTextureUrl('blob:http://localhost/abc')).toBe(true);
      expect(isBlobTextureUrl('https://example.com/img.jpg')).toBe(false);
    });
  });

  describe('TextureCacheTracker', () => {
    it('touch moves key to most recent and tracks bytes', () => {
      const tracker = new TextureCacheTracker();
      tracker.touch('a', 100);
      tracker.touch('b', 200);
      expect(tracker.entryCount).toBe(2);
      expect(tracker.estimatedBytes).toBe(300);

      tracker.touch('a', 150);
      expect(tracker.estimatedBytes).toBe(350);
      expect(tracker.entryCount).toBe(2);
    });

    it('remove drops bytes and entry', () => {
      const tracker = new TextureCacheTracker();
      tracker.touch('a', 100);
      tracker.remove('a');
      expect(tracker.entryCount).toBe(0);
      expect(tracker.estimatedBytes).toBe(0);
    });

    it('evicts LRU entries when over count cap', () => {
      const tracker = new TextureCacheTracker();
      const destroyed: string[] = [];
      const destroy = (key: string) => {
        destroyed.push(key);
        tracker.remove(key);
      };

      for (let i = 0; i < TEXTURE_CACHE_MAX_ENTRIES + 2; i++) {
        tracker.touch(`remote-${i}`, 1024);
      }
      tracker.evictToBudget(['remote-11', 'remote-12'], destroy);

      expect(tracker.entryCount).toBe(TEXTURE_CACHE_MAX_ENTRIES);
      expect(destroyed).toContain('remote-0');
      expect(destroyed).not.toContain('remote-11');
      expect(destroyed).not.toContain('remote-12');
    });

    it('never evicts keys in keepUrls even when over budget', () => {
      const tracker = new TextureCacheTracker();
      const destroyed: string[] = [];
      const destroy = (key: string) => {
        destroyed.push(key);
        tracker.remove(key);
      };

      tracker.touch('keep-a', 50);
      tracker.touch('keep-b', 50);
      for (let i = 0; i < 20; i++) {
        tracker.touch(`other-${i}`, 1024);
      }

      tracker.evictToBudget(['keep-a', 'keep-b'], destroy, { maxEntries: 2, byteBudget: 100 });

      expect(tracker.bytesFor('keep-a')).toBe(50);
      expect(tracker.bytesFor('keep-b')).toBe(50);
      expect(destroyed.every((k) => k !== 'keep-a' && k !== 'keep-b')).toBe(true);
    });

    it('immediately evicts blob URLs not in keep set', () => {
      const tracker = new TextureCacheTracker();
      const destroyed: string[] = [];
      const destroy = (key: string) => {
        destroyed.push(key);
        tracker.remove(key);
      };

      tracker.touch('blob:http://localhost/1', 100);
      tracker.touch('blob:http://localhost/2', 100);
      tracker.touch('https://example.com/a.jpg', 100);

      tracker.evictToBudget(['blob:http://localhost/2'], destroy);

      expect(destroyed).toContain('blob:http://localhost/1');
      expect(destroyed).not.toContain('blob:http://localhost/2');
      expect(tracker.bytesFor('https://example.com/a.jpg')).toBe(100);
    });

    it('evicts by byte budget using LRU order', () => {
      const tracker = new TextureCacheTracker();
      const destroyed: string[] = [];
      const destroy = (key: string) => {
        destroyed.push(key);
        tracker.remove(key);
      };

      tracker.touch('old', 80);
      tracker.touch('mid', 80);
      tracker.touch('new', 80);

      tracker.evictToBudget([], destroy, { maxEntries: 10, byteBudget: 160 });

      expect(tracker.entryCount).toBe(2);
      expect(tracker.estimatedBytes).toBe(160);
      expect(destroyed).toEqual(['old']);
    });

    it('re-touching same URL does not double-count bytes', () => {
      const tracker = new TextureCacheTracker();
      tracker.touch('same', 100);
      tracker.touch('same', 100);
      expect(tracker.entryCount).toBe(1);
      expect(tracker.estimatedBytes).toBe(100);
    });

    it('replace entry updates byte total (uploadPixels simulation)', () => {
      const tracker = new TextureCacheTracker();
      tracker.touch('key', 100);
      tracker.remove('key');
      tracker.touch('key', 200);
      expect(tracker.estimatedBytes).toBe(200);
    });

    it('clear resets tracker', () => {
      const tracker = new TextureCacheTracker();
      tracker.touch('a', 100);
      tracker.clear();
      expect(tracker.entryCount).toBe(0);
      expect(tracker.estimatedBytes).toBe(0);
    });

    it('uses default byte budget constant', () => {
      expect(TEXTURE_CACHE_BYTE_BUDGET).toBe(256 * 1024 * 1024);
    });
  });
});
