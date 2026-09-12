import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import decayTable from '../../../shared/decay.json';
import {
  DECAY,
  DECAY_IDLE_EXPONENT,
  DECAY_OVERLAP_EXPONENT,
  DECAY_RESIDUAL_BRIGHTNESS,
  durationToDecay,
  effectiveDecay,
} from '../math/decay';
import { PERSISTENCE_FRAGMENT_SOURCE } from '../webgl/shaders/persistence';
import { DECAY_GLSL, DECAY_SHADER_FLOAT, DECAY_WGSL } from './decayLiterals';
import { persistenceCompositeFragmentSource, persistenceFragmentSource } from './persistence';

/**
 * Decay-constant divergence guard — the `bandTable.test.ts` counterpart for the
 * tracer persistence fade. shared/decay.json is the single source; TS, WGSL,
 * GLSL and the generated C++ header must all agree.
 */

const CPP_ROOT = join(__dirname, '../../../cpp');

/** Shader-module sources that must interpolate the table, never hand-write it. */
const SHADER_MODULES = [
  ['shaders/persistence.ts', join(__dirname, 'persistence.ts')],
  ['webgl/shaders/persistence.ts', join(__dirname, '../webgl/shaders/persistence.ts')],
] as const;

describe('canonical decay table', () => {
  it('exposes shared/decay.json unchanged', () => {
    expect(DECAY).toEqual(decayTable.constants);
    expect(DECAY_RESIDUAL_BRIGHTNESS).toBe(decayTable.constants.residualBrightness);
    expect(DECAY_OVERLAP_EXPONENT).toBe(decayTable.constants.overlapDecayExponent);
    expect(DECAY_IDLE_EXPONENT).toBe(decayTable.constants.idleDecayExponent);
  });

  it('keeps the residual brightness a fade (0 < residual < 1)', () => {
    expect(DECAY_RESIDUAL_BRIGHTNESS).toBeGreaterThan(0);
    expect(DECAY_RESIDUAL_BRIGHTNESS).toBeLessThan(1);
  });

  it('fades overlapping pixels faster than idle ones', () => {
    expect(DECAY_OVERLAP_EXPONENT).toBeGreaterThan(DECAY_IDLE_EXPONENT);
    // An idle exponent of 1 means "apply durationToDecay() as-is", which is
    // what the duration→brightness contract in decay.test.ts assumes.
    expect(DECAY_IDLE_EXPONENT).toBe(1);

    const decay = durationToDecay(500, 30);
    expect(effectiveDecay(decay, false)).toBeCloseTo(decay, 12);
    expect(effectiveDecay(decay, true)).toBeLessThan(effectiveDecay(decay, false));
  });

  it('formats every constant as a shader f32 literal', () => {
    for (const [name, value] of Object.entries(DECAY)) {
      expect(DECAY_SHADER_FLOAT[name as keyof typeof DECAY]).toBe(value.toFixed(1));
    }
    // WGSL and GLSL share one table — a divergence here would be silent.
    expect(DECAY_WGSL).toBe(DECAY_GLSL);
  });
});

describe('WGSL persistence consumes the canonical table', () => {
  const wgslSources = [
    ['fused persistence', persistenceFragmentSource],
    ['compute-fed composite', persistenceCompositeFragmentSource],
  ] as const;

  it.each(wgslSources)('%s selects between the canonical exponents', (_name, source) => {
    expect(source).toContain(
      `select(${DECAY_WGSL.idleDecayExponent}, ${DECAY_WGSL.overlapDecayExponent},`,
    );
    expect(source).toContain('pow(pu.decayFactor, decayMod)');
  });
});

describe('GLSL persistence consumes the canonical table', () => {
  it('selects between the canonical exponents', () => {
    expect(PERSISTENCE_FRAGMENT_SOURCE).toContain(
      `hadOverlap ? ${DECAY_GLSL.overlapDecayExponent} : ${DECAY_GLSL.idleDecayExponent}`,
    );
    expect(PERSISTENCE_FRAGMENT_SOURCE).toContain('pow(u_decay, decayMod)');
  });
});

describe('shader modules do not hardcode decay literals', () => {
  // The overlap exponent is the distinctive one — the idle exponent (1.0) and
  // the residual (0.1) are too common as unrelated literals to guard this way.
  it.each(SHADER_MODULES)('%s contains no hand-written overlap exponent', (_name, path) => {
    const source = readFileSync(path, 'utf8');
    const literal = DECAY_SHADER_FLOAT.overlapDecayExponent.replace('.', '\\.');
    expect(source).not.toMatch(new RegExp(`\\b${literal}\\b`));
  });
});

describe('C++ engine divergence guard', () => {
  it('decay_table.h matches shared/decay.json (run npm run codegen:decay)', () => {
    const header = readFileSync(join(CPP_ROOT, 'decay_table.h'), 'utf8');
    const constantOf = (name: string) => {
      const match = header.match(
        new RegExp(`constexpr float ${name} = ([0-9.]+)f;`),
      );
      expect(match, `decay_table.h is missing ${name}`).not.toBeNull();
      return Number(match![1]);
    };

    expect(constantOf('DECAY_RESIDUAL_BRIGHTNESS')).toBe(DECAY_RESIDUAL_BRIGHTNESS);
    expect(constantOf('DECAY_OVERLAP_EXPONENT')).toBe(DECAY_OVERLAP_EXPONENT);
    expect(constantOf('DECAY_IDLE_EXPONENT')).toBe(DECAY_IDLE_EXPONENT);
  });

  it('chromashift_engine.cpp reads the residual from the generated header', () => {
    const source = readFileSync(join(CPP_ROOT, 'chromashift_engine.cpp'), 'utf8');
    expect(source).toContain('#include "decay_table.h"');
    expect(source).toContain('std::pow(chromashift::DECAY_RESIDUAL_BRIGHTNESS, 1.0f / frames)');
    // The literal it replaced must not creep back in.
    expect(source).not.toContain(`std::pow(${DECAY_RESIDUAL_BRIGHTNESS}f`);
  });
});
