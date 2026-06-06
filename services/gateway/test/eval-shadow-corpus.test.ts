/**
 * Shadow corpus-accuracy — Phase 1 (BOOTSTRAP-SHADOW-CORPUS-ACCURACY).
 *
 * Proves the corpus → ground-truth-score → accuracy-rollup pipeline:
 *   1. scoreGroundTruth: per-comparison correctness vs the labeled tool.
 *   2. accuracyRollup: feature-level accuracy over a mixed labeled/unlabeled stream.
 *   3. runWithShadowAwaitable carries expected_key/primary_correct/candidate_correct
 *      into the emitted event when a groundTruthKey is supplied.
 *   4. The corpus runner scores exactly one comparison per labeled corpus turn.
 */
process.env.NODE_ENV = 'test';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/feature-flags', () => ({
  isFeatureLive: jest.fn(),
}));

import { scoreGroundTruth, accuracyRollup } from '../src/services/shadow-accuracy';
import { runWithShadowAwaitable } from '../src/services/llm-router-shadow';
import { emitOasisEvent } from '../src/services/oasis-event-service';
import { isFeatureLive } from '../src/services/feature-flags';
import { loadLabeledTurns, simulateAndScore } from './eval/shadow-corpus-runner';

const mockEmit = emitOasisEvent as jest.Mock;
const mockFlag = isFeatureLive as jest.Mock;

beforeEach(() => {
  mockEmit.mockClear();
  mockFlag.mockReset();
});

describe('scoreGroundTruth', () => {
  test('scores primary + candidate against the labeled key', () => {
    expect(scoreGroundTruth('set_reminder', 'set_reminder', 'search_calendar')).toEqual({
      expected_key: 'set_reminder',
      primary_correct: true,
      candidate_correct: false,
    });
  });

  test('unlabeled turn → all-null (agreement-only traffic is unaffected)', () => {
    expect(scoreGroundTruth(null, 'a', 'b')).toEqual({
      expected_key: null,
      primary_correct: null,
      candidate_correct: null,
    });
  });

  test('null candidate key (errored) → candidate_correct null, primary still scored', () => {
    expect(scoreGroundTruth('remember', 'remember', null)).toEqual({
      expected_key: 'remember',
      primary_correct: true,
      candidate_correct: null,
    });
  });
});

describe('accuracyRollup', () => {
  test('computes accuracy over labeled rows and ignores unlabeled ones', () => {
    const rows = [
      { primary_correct: true, candidate_correct: true },
      { primary_correct: true, candidate_correct: false },
      { primary_correct: false, candidate_correct: false },
      { primary_correct: true, candidate_correct: null }, // candidate errored
      { agreement: true }, // unlabeled — must be ignored
    ];
    const acc = accuracyRollup(rows as { primary_correct?: unknown; candidate_correct?: unknown }[]);
    expect(acc.labeled_comparisons).toBe(4);
    expect(acc.primary_accuracy).toBeCloseTo(3 / 4); // 3 of 4 primary correct
    expect(acc.candidate_accuracy).toBeCloseTo(1 / 3); // 1 of 3 non-null candidate correct
  });

  test('no labeled rows → null accuracy, zero labeled', () => {
    const acc = accuracyRollup([{ agreement: false }, {}]);
    expect(acc).toEqual({
      labeled_comparisons: 0, primary_accuracy: null, candidate_accuracy: null,
      real_labeled_comparisons: 0, real_primary_accuracy: null, real_candidate_accuracy: null,
    });
  });

  test('simulated rows count toward display accuracy but NOT real_* (gate safety)', () => {
    const acc = accuracyRollup([
      // two simulated labeled comparisons (both candidate-correct)
      { primary_correct: true, candidate_correct: true, simulated_models: true },
      { primary_correct: true, candidate_correct: true, simulated_models: true },
      // one REAL labeled comparison (candidate wrong)
      { primary_correct: true, candidate_correct: false, simulated_models: false },
    ]);
    // Display view sees all three.
    expect(acc.labeled_comparisons).toBe(3);
    expect(acc.candidate_accuracy).toBeCloseTo(2 / 3);
    // Real view sees only the one non-simulated row — so the gate can't be
    // fooled by simulated candidate accuracy.
    expect(acc.real_labeled_comparisons).toBe(1);
    expect(acc.real_primary_accuracy).toBe(1);
    expect(acc.real_candidate_accuracy).toBe(0);
  });
});

describe('runWithShadowAwaitable — ground truth passthrough', () => {
  test('emits expected_key + primary_correct + candidate_correct + labels when groundTruthKey set', async () => {
    mockFlag.mockReturnValue(true);
    const { shadowDone } = await runWithShadowAwaitable<{ t: string }, { tool_name: string }>({
      feature: 'voice-tool-router',
      input: { t: 'remind me to drink water' },
      primary: async () => ({ tool_name: 'set_reminder' }),
      candidate: async () => ({ tool_name: 'search_calendar' }),
      extractKey: (o) => o.tool_name,
      groundTruthKey: 'set_reminder',
      labels: { corpus_grounded: true, fixture_id: 'synthetic-005-calendar-management' },
    });
    await shadowDone;

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const payload = mockEmit.mock.calls[0][0].payload;
    expect(payload.expected_key).toBe('set_reminder');
    expect(payload.primary_correct).toBe(true);
    expect(payload.candidate_correct).toBe(false);
    expect(payload.agreement).toBe(false);
    // labels flow through
    expect(payload.corpus_grounded).toBe(true);
    expect(payload.fixture_id).toBe('synthetic-005-calendar-management');
  });

  test('no groundTruthKey → correctness fields are null (back-compat)', async () => {
    mockFlag.mockReturnValue(true);
    const { shadowDone } = await runWithShadowAwaitable<{ t: string }, { tool_name: string }>({
      feature: 'voice-tool-router',
      input: { t: 'x' },
      primary: async () => ({ tool_name: 'set_reminder' }),
      candidate: async () => ({ tool_name: 'set_reminder' }),
      extractKey: (o) => o.tool_name,
    });
    await shadowDone;
    const payload = mockEmit.mock.calls[0][0].payload;
    expect(payload.expected_key).toBeNull();
    expect(payload.primary_correct).toBeNull();
    expect(payload.candidate_correct).toBeNull();
    expect(payload.agreement).toBe(true);
  });
});

describe('corpus runner', () => {
  test('scores exactly one comparison per labeled corpus turn, carrying expected_tool', () => {
    const turns = loadLabeledTurns();
    expect(turns.length).toBeGreaterThanOrEqual(30);
    // every labeled turn has a real expected_tool
    turns.forEach((t) => expect(t.expected_tool.length).toBeGreaterThan(0));

    const scored = simulateAndScore(turns, '2026-06-03');
    expect(scored.length).toBe(turns.length);
    scored.forEach((s, i) => {
      expect(s.expected).toBe(turns[i].expected_tool);
      // primary is always scored against truth (never null — primary never errors here)
      expect(typeof s.primary_correct).toBe('boolean');
    });

    // The simulated accuracy is realistic (primary high, derived deterministically).
    const acc = accuracyRollup(scored);
    expect(acc.labeled_comparisons).toBe(turns.length);
    expect(acc.primary_accuracy).toBeGreaterThan(0.8);
    expect(acc.primary_accuracy).toBeLessThanOrEqual(1);
  });

  test('deterministic per seed (re-runs reproduce)', () => {
    const turns = loadLabeledTurns();
    const a = simulateAndScore(turns, 'seed-x');
    const b = simulateAndScore(turns, 'seed-x');
    expect(a).toEqual(b);
  });
});
