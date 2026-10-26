import { CANONICAL_LAYER_COUNT, clampLayerCount } from '../engine/graph/layerSpecs';
import { createDefaultCompareView } from './defaults';
import type { ChromashiftState } from './types';
import type { CompareSlotConfig, CompareViewState } from '../engine/compareViews';
import { CLASSIC_PROFILE_ID, isClassicProfile } from '../engine/color/colorProfile';
import {
  DEFAULT_MOTION_DECAY_BIAS,
  DEFAULT_MOTION_GAIN,
  DEFAULT_MOTION_MODE,
  DEFAULT_MOTION_THRESHOLD,
} from '../engine/motionModes';
import { decode, formatIssues, type SchemaIssue } from './schemaFields';
import {
  rawSettingsSchema,
  type ChromashiftSettingsInput,
  type RawSettings,
} from './settingsSchema';

/**
 * Current preset schema.
 *
 * v5 added the tracer motion term, v6 is reserved for the timeline work
 * (issue #153), v7 is the variable layer count, and v8 the opt-in Canvas HDR
 * flag (`viewport.canvasHdr`). v6 is listed as supported so a document written
 * by that branch still loads here: the layer migration below treats anything
 * before v7 identically.
 */
export const SETTINGS_SCHEMA_VERSION = 8 as const;
export const SUPPORTED_SETTINGS_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** First schema version that carries `layers.count` and variable-length arrays. */
export const LAYER_COUNT_SCHEMA_VERSION = 7;

/** First schema version that carries `viewport.canvasHdr`. */
export const CANVAS_HDR_SCHEMA_VERSION = 8;

export interface ChromashiftSettingsDocument {
  version: typeof SETTINGS_SCHEMA_VERSION;
  settings: ChromashiftSettingsInput;
}

/** A decoded document of any supported version, before migration. */
export interface RawSettingsDocument {
  version: number;
  settings: RawSettings;
}

function cloneCompareView(compareView: CompareViewState): CompareViewState {
  return {
    layout: compareView.layout,
    syncPlay: compareView.syncPlay,
    swipePosition: compareView.swipePosition,
    quadLayerIndex: compareView.quadLayerIndex ?? 0,
    slotA: {
      ...compareView.slotA,
      settings: { ...compareView.slotA.settings },
    },
    slotB: {
      ...compareView.slotB,
      settings: { ...compareView.slotB.settings },
    },
  };
}

/**
 * A document's compare view over the session default: any subset of the
 * fields loads, and the rest is the default single view.
 */
function migrateCompareView(compare: RawSettings['compare']): CompareViewState {
  const fallback = createDefaultCompareView();
  if (!compare) return fallback;
  const slot = (
    base: CompareSlotConfig,
    patch: NonNullable<RawSettings['compare']>['slotA'],
  ): CompareSlotConfig => ({
    ...base,
    ...patch,
    settings: { ...(patch?.settings ?? base.settings) },
  });
  return {
    layout: compare.layout ?? fallback.layout,
    syncPlay: compare.syncPlay ?? fallback.syncPlay,
    swipePosition: compare.swipePosition ?? fallback.swipePosition,
    quadLayerIndex: compare.quadLayerIndex ?? fallback.quadLayerIndex,
    slotA: slot(fallback.slotA, compare.slotA),
    slotB: slot(fallback.slotB, compare.slotB),
  };
}

/**
 * v3 added named colour profiles. Older documents predate them, so they migrate
 * to the classic profile — the look they were saved with. An embedded profile
 * table has already been through `parseColorProfile` in the schema, so a corrupt
 * one never gets this far.
 */
function migrateColorProfile(
  layers: RawSettings['layers'],
): RawSettings['layers'] {
  const colorProfileId = layers?.colorProfileId || CLASSIC_PROFILE_ID;
  const embedded = layers?.colorProfile ?? null;

  return {
    ...layers,
    colorProfileId,
    // Only keep an embedded table that actually describes the selected profile.
    colorProfile: embedded && embedded.id === colorProfileId ? embedded : null,
  };
}

/**
 * v5 added the tracer motion (temporal) term. A v1–v4 document predates it, so
 * it migrates to `motionMode: 'off'` — the mode that renders exactly what the
 * preset was saved as. The numeric parameters get their defaults, which are
 * inert while the mode is off but keep a later toggle from landing on zeroes.
 */
function migrateMotion(
  tracers: RawSettings['tracers'],
): RawSettings['tracers'] {
  return {
    ...tracers,
    motionMode: tracers?.motionMode ?? DEFAULT_MOTION_MODE,
    motionGain: tracers?.motionGain ?? DEFAULT_MOTION_GAIN,
    motionDecayBias: tracers?.motionDecayBias ?? DEFAULT_MOTION_DECAY_BIAS,
    motionThreshold: tracers?.motionThreshold ?? DEFAULT_MOTION_THRESHOLD,
  };
}

/**
 * v7 made the layer count a session parameter. A v1–v6 document predates it and
 * was always three layers, so it migrates as `count: 3` with its existing
 * triples carried over in place — the arrays are already the right length, they
 * just had no count beside them.
 *
 * A v7 document states its own count; the arrays are trusted only as far as
 * `normalizeLayersSlice` in the reducer, which resizes them to match. An absent
 * or out-of-range count clamps to the canonical three rather than failing the
 * load, so a hand-edited preset degrades to the default look instead of nothing.
 */
function migrateLayerCount(
  layers: RawSettings['layers'],
  version: number,
): RawSettings['layers'] {
  const count = version >= LAYER_COUNT_SCHEMA_VERSION
    ? clampLayerCount(layers?.count ?? layers?.angles?.length)
    : CANONICAL_LAYER_COUNT;

  return { ...layers, count };
}

/**
 * v8 added Canvas HDR. Anything older predates it and presents SDR; a v8
 * document enables it only with an explicit `true`, so a preset that omits
 * the flag never switches a viewer's canvas to HDR.
 */
function migrateCanvasHdr(
  viewport: RawSettings['viewport'],
  version: number,
): boolean {
  return version >= CANVAS_HDR_SCHEMA_VERSION && viewport?.canvasHdr === true;
}

/**
 * Normalize a decoded v1–v8 document to the current schema. The input has
 * already been through {@link rawSettingsSchema}, so every field here is
 * present-and-valid or absent; the migrations only move and default.
 */
export function migrateToLatest(doc: RawSettingsDocument): ChromashiftSettingsDocument {
  const {
    viewportQuarterZoom: legacyQuarterZoom,
    viewportHalfOverlay: legacyHalfOverlay,
    displayColorSpace: legacyColorSpace,
    ...output
  } = doc.settings.output ?? {};
  const { settings } = doc;

  const reactive = settings.reactive
    ? {
        enabled: settings.reactive.enabled ?? false,
        audioEnabled: settings.reactive.audioEnabled ?? false,
        midiEnabled: settings.reactive.midiEnabled ?? false,
        audioSensitivity: settings.reactive.audioSensitivity ?? 1,
        midiBindings: settings.reactive.midiBindings?.map((b) => ({ ...b })) ?? [],
      }
    : undefined;

  return {
    version: SETTINGS_SCHEMA_VERSION,
    settings: {
      ...settings,
      layers: migrateLayerCount(migrateColorProfile(settings.layers), doc.version),
      tracers: migrateMotion(settings.tracers),
      output: settings.output ? output : undefined,
      reactive,
      viewport: {
        quarterZoom: settings.viewport?.quarterZoom ?? legacyQuarterZoom ?? false,
        halfOverlay: settings.viewport?.halfOverlay ?? legacyHalfOverlay ?? false,
        colorSpace: settings.viewport?.colorSpace ?? legacyColorSpace ?? 'srgb',
        canvasHdr: migrateCanvasHdr(settings.viewport, doc.version),
      },
      compare: migrateCompareView(settings.compare),
      kiosk: {
        kioskEnabled: settings.kiosk?.kioskEnabled ?? false,
        kioskUiHidden: settings.kiosk?.kioskUiHidden ?? false,
        kioskAttractMode: settings.kiosk?.kioskAttractMode ?? false,
      },
    },
  };
}

export interface SerializeSettingsOptions {
  /**
   * Embed the full colour-profile table for user profiles. On by default so an
   * exported file / stored preset is self-contained; `?preset=` URLs turn it off
   * and carry the profile id alone to stay short (see docs/COLOR_PROFILES.md).
   */
  embedColorProfile?: boolean;
  /**
   * Drop `layers.count` when it is the canonical three, so a `?preset=` URL for
   * a default session is no longer than it was before v7. The count is
   * recoverable from `layers.angles.length`, which the v7 migration falls back
   * to. Off by default — an exported file states its count outright.
   */
  compactLayers?: boolean;
}

export function serializeSettings(
  state: ChromashiftState,
  options: SerializeSettingsOptions = {},
): ChromashiftSettingsDocument {
  const { layers, tracers, output, engine, ui, reactive } = state;
  const embedColorProfile = options.embedColorProfile !== false;
  const { count, ...layersWithoutCount } = layers;
  const layersPreset = options.compactLayers === true && count === CANONICAL_LAYER_COUNT
    ? layersWithoutCount
    : layers;
  const {
    tracerInspect,
    tracerPreviewFrozen: _tracerPreviewFrozen,
    livePreviewEnabled: _livePreviewEnabled,
    viewportQuarterZoom,
    viewportHalfOverlay,
    displayColorSpace,
    canvasHdr,
    ...outputPreset
  } = output;
  void _tracerPreviewFrozen;
  void _livePreviewEnabled;

  return {
    version: SETTINGS_SCHEMA_VERSION,
    settings: {
      layers: {
        ...layersPreset,
        colorProfile: embedColorProfile && !isClassicProfile(layers.colorProfileId)
          ? layers.colorProfile
          : null,
      },
      tracers: { ...tracers },
      output: {
        ...outputPreset,
        tracerInspect: { ...tracerInspect },
      },
      engine: {
        fps: engine.fps,
        paused: engine.paused,
        engineMode: engine.engineMode,
        avgLuminance: engine.avgLuminance,
      },
      ui: {
        isAutoPlayActive: ui.isAutoPlayActive,
        imageChangeInterval: ui.imageChangeInterval,
        referenceBlendMode: ui.referenceBlendMode,
        overlayImageSource: ui.overlayImageSource,
        referenceOpacity: ui.referenceOpacity,
        upscaleModel: ui.upscaleModel,
      },
      reactive: {
        enabled: reactive.enabled,
        audioEnabled: reactive.audioEnabled,
        midiEnabled: reactive.midiEnabled,
        audioSensitivity: reactive.audioSensitivity,
        midiBindings: reactive.midiBindings.map((b) => ({ ...b })),
      },
      viewport: {
        quarterZoom: viewportQuarterZoom,
        halfOverlay: viewportHalfOverlay,
        colorSpace: displayColorSpace,
        canvasHdr,
      },
      compare: cloneCompareView(ui.compareView),
      kiosk: {
        kioskEnabled: ui.kioskEnabled,
        kioskUiHidden: ui.kioskUiHidden,
        kioskAttractMode: ui.kioskAttractMode,
      },
    },
  };
}

export interface DecodedSettings {
  /** The migrated document, or null when the envelope itself is unusable. */
  document: ChromashiftSettingsDocument | null;
  /** Every field the decoder clamped, rounded or dropped, by path. */
  issues: SchemaIssue[];
}

/**
 * Decode an untrusted settings document (file, `?preset=` URL, localStorage).
 *
 * Only the envelope is all-or-nothing: unparseable JSON, a missing `settings`
 * object or an unsupported `version` reject the document. Inside it, each bad
 * field is clamped or dropped on its own and reported in `issues`.
 */
export function decodeSettingsDocument(json: string): DecodedSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { document: null, issues: [{ path: '(root)', message: 'not valid JSON' }] };
  }
  const { version, settings } = (parsed ?? {}) as { version?: unknown; settings?: unknown };
  if (!SUPPORTED_SETTINGS_VERSIONS.some((supported) => supported === version)) {
    return { document: null, issues: [{ path: 'version', message: 'missing or unsupported version' }] };
  }
  // Paths are relative to `settings` (`engine.fps`), the same as a ParamPath.
  const { value, issues } = decode(rawSettingsSchema, settings);
  if (!value) return { document: null, issues };
  return {
    document: migrateToLatest({ version: version as number, settings: value }),
    issues,
  };
}

/**
 * {@link decodeSettingsDocument}, logging one warning that lists every
 * corrected path. Returns null only for an unusable envelope.
 */
export function deserializeSettings(
  json: string,
): ChromashiftSettingsDocument | null {
  const { document, issues } = decodeSettingsDocument(json);
  if (document && issues.length > 0) {
    console.warn(`[chromashift] preset loaded with ${issues.length} correction(s): ${formatIssues(issues)}`);
  }
  return document;
}

export function settingsToJson(state: ChromashiftState, pretty = true): string {
  return JSON.stringify(serializeSettings(state), null, pretty ? 2 : undefined);
}
