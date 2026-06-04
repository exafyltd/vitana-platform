/**
 * Golden-corpus integrity — Phase 1 (BOOTSTRAP-GOLDEN-CORPUS-EXPANSION).
 *
 * The replay runner (test/eval/replay-runner.ts) and every downstream
 * tool-routing / intent accuracy score depends on the golden corpus being
 * well-formed and its labels being well-shaped.
 *
 * NOTE on taxonomy: the corpus is a GENERAL eval set. Its `expected_intent`
 * labels are free-form dotted identifiers (types.ts: "e.g. task.create") and
 * legitimately span more than the 6-kind classifier vocab — greeting, plan,
 * screen-navigation, etc. So we gate on STRUCTURE + label FORMAT (lowercase
 * snake/dotted), not a closed vocabulary, which would wrongly reject the
 * navigation/greeting fixtures. A malformed label (spaces, casing, empty)
 * still fails — that's what silently poisons accuracy scoring.
 */
process.env.NODE_ENV = 'test';

import * as fs from 'fs';
import * as path from 'path';
import type { GoldenCorpusFixture } from './eval/types';

const CORPUS_DIR = path.join(__dirname, 'eval', 'golden-corpus');

// Label format: lowercase identifier, optionally dotted (e.g. `memory.write`,
// `screen.community.feed`). Catches casing/space/garbage typos without pinning
// a closed vocabulary that drifts as tools + routes are added.
const DOTTED_LABEL = /^[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9_]*)*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

function loadCorpus(): { file: string; fx: GoldenCorpusFixture }[] {
  return fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({
      file,
      fx: JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, file), 'utf-8')) as GoldenCorpusFixture,
    }));
}

describe('golden corpus — integrity', () => {
  const corpus = loadCorpus();

  test('corpus is non-trivial (expanded well past the W1 smoke seed of 3)', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(15);
  });

  test.each(loadCorpus().map(({ file, fx }) => [file, fx] as const))(
    '%s is well-formed',
    (file, fx) => {
      // fixture_id matches filename
      expect(`${fx.fixture_id}.json`).toBe(file);
      expect(['synthetic', 'prod-extracted']).toContain(fx.source);
      expect(typeof fx.captured_at).toBe('string');
      // turn_count is honest
      expect(fx.turn_count).toBe(fx.turns.length);
      expect(fx.turns.length).toBeGreaterThan(0);

      fx.turns.forEach((t, idx) => {
        // turns are 1-indexed and contiguous
        expect(t.turn).toBe(idx + 1);
        expect(['voice', 'text']).toContain(t.kind);
        expect(typeof t.user_input).toBe('string');
        expect(t.user_input.trim().length).toBeGreaterThan(0);
        // labels, when present, must be well-shaped (lowercase dotted /
        // snake_case) — a malformed label silently breaks accuracy scoring.
        if (t.expected_intent !== undefined) {
          expect(t.expected_intent).toMatch(DOTTED_LABEL);
        }
        if (t.expected_tool !== undefined) {
          expect(t.expected_tool).toMatch(TOOL_NAME);
        }
      });
    },
  );

  test('fixture_ids are unique', () => {
    const ids = corpus.map(({ fx }) => fx.fixture_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('carries real labeled tool-routing signal (not just latency probes)', () => {
    const labeledTurns = corpus
      .flatMap(({ fx }) => fx.turns)
      .filter((t) => t.expected_tool !== undefined).length;
    // The expanded corpus must encode substantive routing ground truth.
    expect(labeledTurns).toBeGreaterThanOrEqual(30);
  });
});
