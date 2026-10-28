/**
 * Eval harness types — Phase 1 W1 (VTID-03177 PROFILE).
 *
 * A "golden corpus" is a set of recorded prod sessions captured for replay.
 * Each fixture is one session: a sequence of user turns + the expected
 * primary-model response shape (intent, tool calls, voice or text).
 *
 * The replay runner is intentionally narrow in W1: it measures per-turn
 * latency against a configurable gateway URL and produces a summary report.
 * W2+ expands assertions (tool-routing accuracy, transcript quality).
 */

export type GoldenTurnKind = 'voice' | 'text';

export interface GoldenTurn {
  /** Increment within the session, starting at 1. */
  turn: number;
  /** What the user said/typed (canonical UTF-8). */
  user_input: string;
  /** Voice or text turn. Voice turns simulate audio; W1 just runs the text-equivalent. */
  kind: GoldenTurnKind;
  /** Optional canonical expected tool name (e.g. `send_chat_message`); used for accuracy scoring. */
  expected_tool?: string;
  /** Optional canonical expected intent kind (e.g. `task.create`). */
  expected_intent?: string;
}

export interface GoldenCorpusFixture {
  /** Stable id; matches filename (without `.json`). */
  fixture_id: string;
  /** Source: `prod-extracted` for sessions pulled from prod, `synthetic` for hand-crafted. */
  source: 'prod-extracted' | 'synthetic';
  /** When the fixture was captured. */
  captured_at: string;
  /** Number of turns; sanity check vs `turns.length`. */
  turn_count: number;
  /** Free-form notes (e.g. why this session was chosen). */
  notes?: string;
  turns: GoldenTurn[];
}

export interface ReplayPhaseTiming {
  phase: string;
  start_ms: number;
  end_ms?: number;
  duration_ms?: number;
}

export interface ReplayTurnResult {
  turn: number;
  ok: boolean;
  /** Total wall-clock for the turn (request-in to response-finish). */
  total_ms: number;
  /** Phased timings, when Server-Timing was present. */
  phases: ReplayPhaseTiming[];
  /** HTTP status of the gateway response. */
  http_status?: number;
  /** Error text if `ok` is false. */
  error?: string;
}

export interface ReplayFixtureResult {
  fixture_id: string;
  ok: boolean;
  turn_results: ReplayTurnResult[];
  /** p50/p95/p99 of total_ms across turns. */
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  error?: string;
}

export interface ReplayRunOutput {
  run_id: string;
  started_at: string;
  finished_at: string;
  gateway_url: string;
  fixtures: ReplayFixtureResult[];
  /** Roll-up across all turns of all fixtures. */
  totals: {
    fixtures_total: number;
    fixtures_ok: number;
    turns_total: number;
    turns_ok: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
  };
}
