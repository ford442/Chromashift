import { describe, expect, it } from 'vitest';

import { GRAPH_PRESETS, buildGraphPreset } from './altGraphs';
import { graphCapabilityNeeds, missingCapabilityError, webGpuDeviceCapabilities } from './capabilities';
import { CANONICAL_LAYER_COUNT, MAX_LAYER_COUNT } from './layerSpecs';
import { presentingTo, presetGraphSource } from './variants';

const CORE = {
  featureLevel: 'core',
  features: new Set<string>(),
  limits: { maxTextureDimension2D: 8192 },
  hdrCanvas: false,
} as const;

/** A GL ES-class compatibility-mode device: no fragment storage, no optional features. */
const GL_COMPATIBILITY = {
  featureLevel: 'compatibility',
  features: new Set<string>(),
  limits: { maxTextureDimension2D: 4096, maxStorageBuffersInFragmentStage: 0, maxStorageTexturesInFragmentStage: 0 },
  hdrCanvas: false,
} as const;

describe('webGpuDeviceCapabilities', () => {
  it('grants a core device what compatibility mode withholds', () => {
    expect([...webGpuDeviceCapabilities(CORE).granted].sort()).toEqual([
      'depth-texture-load',
      'fragment-storage',
      'independent-blend',
    ]);
  });

  it('withholds it from a compatibility-mode device', () => {
    const capabilities = webGpuDeviceCapabilities(GL_COMPATIBILITY);
    expect([...capabilities.granted]).toEqual([]);
    expect(capabilities).toMatchObject({ featureLevel: 'compatibility', maxTextureDimension2D: 4096 });
  });

  it('grants fragment storage to a compatibility device whose limits allow it', () => {
    // Dawn's compatibility mode over Vulkan reports 4 of each.
    const dawn = { ...GL_COMPATIBILITY, limits: { maxTextureDimension2D: 8192, maxStorageBuffersInFragmentStage: 4, maxStorageTexturesInFragmentStage: 4 } };
    expect([...webGpuDeviceCapabilities(dawn).granted]).toEqual(['fragment-storage']);
  });

  it('grants the optional bits from the feature and the canvas HDR probe, at either level', () => {
    const granted = webGpuDeviceCapabilities({
      ...GL_COMPATIBILITY,
      features: new Set(['texture-formats-tier1']),
      hdrCanvas: true,
    }).granted;
    expect([...granted].sort()).toEqual(['hdr-canvas', 'r8uint-storage']);
  });
});

describe('missingCapabilityError', () => {
  // The compatibility-mode audit, pinned: no SDR variant of any shape needs
  // what it withholds.
  it('passes every preset variant on a compatibility-mode device', () => {
    const capabilities = webGpuDeviceCapabilities(GL_COMPATIBILITY);
    let checked = 0;
    for (const name of GRAPH_PRESETS) {
      for (let layerCount = 1; layerCount <= MAX_LAYER_COUNT; layerCount += 1) {
        // The starter graphs are authored for three bands, and refuse others.
        if (name !== 'default' && name !== 'blur' && name !== 'warp' && layerCount !== CANONICAL_LAYER_COUNT) continue;
        for (const motion of [false, true]) {
          const graph = presetGraphSource(name).build({ layerCount, motion, presentation: 'sdr' });
          expect(graphCapabilityNeeds(graph)).toEqual([]);
          expect(missingCapabilityError(graph, capabilities)).toBeNull();
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(GRAPH_PRESETS.length * 2);
  });

  it('refuses an hdr-extended output by name where the canvas cannot present it', () => {
    const graph = presentingTo(buildGraphPreset('default', 3), 'hdr-extended');
    expect(graphCapabilityNeeds(graph)).toEqual(['hdr-canvas']);

    const refusal = missingCapabilityError(graph, webGpuDeviceCapabilities(GL_COMPATIBILITY));
    expect(refusal?.code).toBe('unsupported-capability');
    expect(refusal?.message).toBe(
      "This compatibility device does not grant 'hdr-canvas', which the graph needs.",
    );
    expect(missingCapabilityError(graph, webGpuDeviceCapabilities({ ...CORE, hdrCanvas: true }))).toBeNull();
  });
});
