import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { decodeSettingsDocument, SUPPORTED_SETTINGS_VERSIONS } from './serializeSettings';
import type { Schema, SchemaNode } from './schemaFields';
import { rawSettingsSchema } from './settingsSchema';

/**
 * Property tests over the preset decoder (#226).
 *
 * Purely random JSON almost never gets past the envelope, so most runs use
 * documents generated *from the schema*: every node is either a plausible value
 * for its kind (including out-of-range numbers, unknown keys, wrong-length
 * arrays) or arbitrary JSON. That reaches every migration and every leaf.
 */

const RUNS = 10_000;
/** 10k documents of ~4 kB each take several seconds; well past vitest's 5 s default on a busy runner. */
const PROPERTY_TIMEOUT_MS = 120_000;

const anyJson = fc.jsonValue({ maxDepth: 2 });

function arbitraryFor(schema: Schema<unknown>, depth = 0): fc.Arbitrary<unknown> {
  const node = schema as SchemaNode;
  let plausible: fc.Arbitrary<unknown>;
  switch (node.kind) {
    case 'number': {
      const { min, max } = node.meta;
      const span = max - min;
      plausible = fc.oneof(
        fc.double({ min, max, noNaN: true }),
        fc.double({ min: min - 2 * span, max: max + 2 * span, noNaN: true }),
        fc.integer({ min: Math.floor(min) - 2, max: Math.ceil(max) + 2 }),
        fc.constantFrom(min, max, -0, 1e308, -1e308),
      );
      break;
    }
    case 'boolean':
      plausible = fc.boolean();
      break;
    case 'enum':
      plausible = fc.constantFrom(...node.values);
      break;
    case 'string':
      plausible = fc.string({ maxLength: node.maxLength + 4 });
      break;
    case 'nullable':
      plausible = fc.oneof(fc.constant(null), arbitraryFor(node.inner, depth + 1));
      break;
    case 'array':
      // Just past the layer cap, so truncation is exercised without huge documents.
      plausible = fc.array(arbitraryFor(node.item, depth + 1), { maxLength: Math.min(node.maxLength + 2, 12) });
      break;
    case 'object': {
      const entries = Object.entries(node.shape).map(
        ([key, child]) => [key, arbitraryFor(child, depth + 1)] as const,
      );
      plausible = fc.tuple(
        fc.record(Object.fromEntries(entries), { requiredKeys: [] }),
        fc.dictionary(fc.string({ maxLength: 8 }), anyJson, { maxKeys: 2 }),
      ).map(([known, extra]) => ({ ...extra, ...known }));
      break;
    }
    default:
      plausible = anyJson;
  }
  // Deep nodes stay mostly plausible so the generator reaches the leaves.
  return fc.oneof({ weight: depth < 2 ? 6 : 12, arbitrary: plausible }, { weight: 1, arbitrary: anyJson });
}

const documentArbitrary = fc.record({
  version: fc.oneof(fc.constantFrom(...SUPPORTED_SETTINGS_VERSIONS), anyJson),
  settings: arbitraryFor(rawSettingsSchema),
}, { requiredKeys: [] });

/** decode → serialize → decode must be a fixed point with no corrections left to make. */
function assertFixedPoint(json: string): void {
  const first = decodeSettingsDocument(json);
  if (!first.document) return;
  const reserialized = JSON.stringify(first.document);
  const second = decodeSettingsDocument(reserialized);
  expect(second.issues).toEqual([]);
  // Value equality against the JSON form: key order is an artefact of the
  // migration spreads, and JSON is what a re-serialized preset actually is.
  expect(second.document).toEqual(JSON.parse(reserialized));
}

describe('deserializeSettings properties', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  it(`never throws, and its output re-decodes to itself with no issues (${RUNS} schema-shaped runs)`, () => {
    fc.assert(
      fc.property(documentArbitrary, (raw) => assertFixedPoint(JSON.stringify(raw))),
      { numRuns: RUNS },
    );
  }, PROPERTY_TIMEOUT_MS);

  it('never throws on arbitrary JSON or arbitrary text', () => {
    fc.assert(
      fc.property(fc.oneof(fc.json(), fc.string()), (text) => assertFixedPoint(text)),
      { numRuns: 2_000 },
    );
  });
});
