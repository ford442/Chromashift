/**
 * The parameter registry: every numeric session setting, addressed by the
 * dotted path it has in both the preset schema and `ChromashiftState`.
 *
 * Nothing here is hand-listed. The paths, ranges, defaults and labels all come
 * from `settingLeavesSchema` in `settingsSchema.ts`, so a new slider leaf in
 * the schema is a new parameter (or, with `automatable: false`, explicitly
 * not one) without touching this file.
 *
 * - {@link paramSpec} / {@link listParams}: what a parameter is.
 * - {@link getParam} / {@link withParam}: pure read / write on state, with
 *   structural sharing — `withParam` returns the same object when nothing moved.
 * - {@link sliderProps}: `min` / `max` / `step` for an `<input type="range">`.
 */

import { DROP, type NumberCurve } from './schemaFields';
import {
  SETTING_LEAVES,
  numericLeafAt,
  type NumericSettingPath,
  type ParamPath,
} from './settingsSchema';
import type { ChromashiftState } from './types';

export type { NumericSettingPath, ParamPath } from './settingsSchema';
export { isNumericSettingPath, isParamPath } from './settingsSchema';

export interface ParamSpec {
  path: ParamPath;
  min: number;
  max: number;
  default: number;
  step?: number;
  curve: NumberCurve;
  label: string;
  unit?: string;
  /** Integer-valued: a sweep lands on whole steps only. */
  discrete?: boolean;
}

function resolve(path: string) {
  const found = numericLeafAt(path);
  if (!found) throw new RangeError(`Unknown setting path "${path}"`);
  return found;
}

function specFor(path: string): Omit<ParamSpec, 'path'> {
  const { leaf, index } = resolve(path);
  const { meta } = leaf;
  return {
    min: meta.min,
    max: meta.max,
    default: index !== null && leaf.defaultAt ? leaf.defaultAt(index) : meta.default,
    ...(meta.step !== undefined ? { step: meta.step } : {}),
    curve: meta.curve,
    label: meta.label.replace('{n}', String(index ?? '')),
    ...(meta.unit !== undefined ? { unit: meta.unit } : {}),
    ...(meta.integer ? { discrete: true } : {}),
  };
}

/** The spec for one parameter; `layers.extensions.7` gets layer 7's label and default. */
export function paramSpec(path: ParamPath): ParamSpec {
  return { path, ...specFor(path) };
}

/** Slider bounds for any numeric setting. An `angle` slider stops one step short of the wrap. */
export function sliderProps(path: NumericSettingPath): { min: number; max: number; step: number } {
  const spec = specFor(path);
  const step = spec.step ?? (spec.discrete ? 1 : 0.01);
  return { min: spec.min, max: spec.curve === 'angle' ? spec.max - step : spec.max, step };
}

/**
 * Every parameter a session with `layerCount` layers has, in schema order:
 * the per-layer ones once per layer, so layer 7 is there at `count = 10`.
 */
export function listParams(layerCount: number): ParamSpec[] {
  return SETTING_LEAVES.filter((leaf) => leaf.meta.automatable).flatMap((leaf) => {
    if (leaf.maxIndex === undefined) return [paramSpec(leaf.path as ParamPath)];
    const count = Math.min(layerCount, leaf.maxIndex + 1);
    return Array.from({ length: count }, (_, i) => paramSpec(leaf.path.replace('*', String(i)) as ParamPath));
  });
}

/** The current value, or undefined for a per-layer path past the session's layer count. */
export function getParam(state: ChromashiftState, path: NumericSettingPath): number | undefined {
  let value: unknown = state;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'number' ? value : undefined;
}

/** Clamp, wrap or round `value` the way decoding a preset would; undefined for NaN / ±Infinity. */
export function coerceParam(path: NumericSettingPath, value: number): number | undefined {
  const coerced = resolve(path).leaf.schema.decode(value, path, { issues: [] });
  return coerced === DROP ? undefined : coerced;
}

function setIn(container: unknown, keys: readonly string[], value: number): unknown {
  const [key, ...rest] = keys;
  if (Array.isArray(container)) {
    const index = Number(key);
    // Writes past the end are dropped rather than growing the array behind
    // `layers.count`'s back — a binding for layer 7 in a 3-layer session must
    // not resize the session.
    if (!Number.isInteger(index) || index < 0 || index >= container.length) return container;
    const next = rest.length ? setIn(container[index], rest, value) : value;
    if (Object.is(next, container[index])) return container;
    const copy = [...container];
    copy[index] = next;
    return copy;
  }
  if (typeof container !== 'object' || container === null) return container;
  const record = container as Record<string, unknown>;
  if (!(key in record)) return container;
  const next = rest.length ? setIn(record[key], rest, value) : value;
  return Object.is(next, record[key]) ? container : { ...record, [key]: next };
}

/**
 * `state` with one setting changed, coerced into its range first. Only the
 * objects on the path are copied; an unchanged value returns `state` itself.
 */
export function withParam(
  state: ChromashiftState,
  path: NumericSettingPath,
  value: number,
): ChromashiftState {
  const coerced = coerceParam(path, value);
  if (coerced === undefined) return state;
  return setIn(state, path.split('.'), coerced) as ChromashiftState;
}

/**
 * Map a normalised control position (a MIDI CC / 127, a 0–1 fader) onto a
 * parameter's range along its curve. The result is in range; discrete
 * parameters land on whole steps.
 */
export function paramFromUnit(spec: ParamSpec, unit: number): number {
  const t = Math.min(Math.max(Number.isFinite(unit) ? unit : 0, 0), 1);
  const value = spec.curve === 'log' && spec.min > 0
    ? spec.min * (spec.max / spec.min) ** t
    : spec.min + t * (spec.max - spec.min);
  return spec.discrete ? Math.round(value) : value;
}

/** Inverse of {@link paramFromUnit}, for drawing a control at a parameter's value. */
export function paramToUnit(spec: ParamSpec, value: number): number {
  const t = spec.curve === 'log' && spec.min > 0
    ? Math.log(value / spec.min) / Math.log(spec.max / spec.min)
    : (value - spec.min) / (spec.max - spec.min);
  return Math.min(Math.max(t, 0), 1);
}

/** `Tracer above intensity`, `Layer 7 rate (°)`. */
export function paramDisplayLabel(spec: ParamSpec): string {
  return spec.unit ? `${spec.label} (${spec.unit})` : spec.label;
}
