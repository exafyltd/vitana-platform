/**
 * VTID-04134 (clarity rename) — `GEMINI_MODEL` -> `LEGACY_GEMINI_API_MODEL`
 * in `services/gateway/src/routes/orb-live.ts`.
 *
 * CLAUDE.md's own VTID-04036 changelog entry flagged this constant as stale
 * ("`voice.latency.measured` labels turns >= 1 as `gemini-2.0-flash-exp`
 * (stale `GEMINI_MODEL` constant in `orb-live.ts`), cosmetic"): the name read
 * as though it selected the live voice provider, while in reality it is only
 * a legacy Gemini API model tag carried in fallback/metadata fields
 * (`GEMINI_API_URL`, the per-turn latency `provider` label, the SSE `ready`
 * meta, the `/start` meta, and `/orb/health`'s `model` field). Nova Sonic is
 * the live voice transport (VTID-03970/04036); this string does not route
 * anything.
 *
 * This is a clarity-only rename: the string value stays exactly
 * 'gemini-2.0-flash-exp'. The test is structural/source-level, matching the
 * established pattern for orb-live.ts (too large/stateful to boot the whole
 * route module for a constant name — see
 * `test/orb/live/characterization/establishment-latency-instrumentation.characterization.test.ts`).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ORB_LIVE_PATH = join(__dirname, '../src/routes/orb-live.ts');

let src: string;

beforeAll(() => {
  src = readFileSync(ORB_LIVE_PATH, 'utf8');
});

describe('VTID-04134: legacy Gemini API model constant rename', () => {
  it('no longer contains the bare GEMINI_MODEL identifier (AC-1)', () => {
    expect(src).not.toMatch(/\bGEMINI_MODEL\b/);
  });

  it('declares LEGACY_GEMINI_API_MODEL with the unchanged legacy string (AC-1/AC-2)', () => {
    expect(src).toMatch(
      /\bLEGACY_GEMINI_API_MODEL\s*=\s*'gemini-2\.0-flash-exp';/,
    );
  });

  it('documents the constant as a legacy/fallback tag, not a live provider selector (AC-1)', () => {
    const declIdx = src.indexOf('const LEGACY_GEMINI_API_MODEL');
    expect(declIdx).toBeGreaterThan(-1);
    // The explanatory comment sits directly above the declaration.
    const precedingBlock = src.slice(Math.max(0, declIdx - 400), declIdx);
    const lastLine = precedingBlock.trimEnd().split('\n').pop() ?? '';
    expect(lastLine.trim().startsWith('//')).toBe(true);
    expect(precedingBlock.toLowerCase()).toContain('legacy');
  });

  it('keeps every former call site on the renamed identifier', () => {
    // The five original references: the derived Gemini REST URL, the per-turn
    // latency provider label, the SSE 'ready' meta, POST /start's meta, and
    // GET /orb/health's `model` field.
    const usages = [
      'models/${LEGACY_GEMINI_API_MODEL}:generateContent',
      '`vertex/${LEGACY_GEMINI_API_MODEL}`',
      "type: 'ready', meta: { model: LEGACY_GEMINI_API_MODEL }",
      'meta: { model: LEGACY_GEMINI_API_MODEL }',
      'model: LEGACY_GEMINI_API_MODEL,',
    ];
    for (const usage of usages) {
      expect(src).toContain(usage);
    }
    // 1 declaration + 5 call sites.
    expect(src.match(/\bLEGACY_GEMINI_API_MODEL\b/g)?.length).toBe(6);
  });
});
