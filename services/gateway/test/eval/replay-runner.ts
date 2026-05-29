/**
 * Golden-corpus replay runner — Phase 1 W1 (VTID-03177 PROFILE).
 *
 * Reads every `*.json` fixture under `golden-corpus/`, replays each turn
 * against a configurable gateway URL, and produces a per-fixture latency
 * roll-up. In W1 the "replay" is a thin probe against `/api/v1/admin/health`
 * — enough to establish a baseline that downstream PRs can compare against
 * once orb-live emits phased `voice.latency.measured` events (PR #1
 * follow-up commit) and the eval harness graduates to driving real chat
 * turns (W2+).
 *
 * Output is JSON to stdout when run via `npm run eval:replay`. The same
 * function is also exported so a future cron workflow can emit the result
 * as an `eval.coverage.report` OASIS event.
 *
 * Acceptance for W1: baseline runs once on staging without throwing.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  GoldenCorpusFixture,
  ReplayFixtureResult,
  ReplayPhaseTiming,
  ReplayRunOutput,
  ReplayTurnResult,
} from './types';

const DEFAULT_GATEWAY = process.env.EVAL_GATEWAY_URL
  || 'https://gateway-staging-q74ibpv6ia-uc.a.run.app';
const CORPUS_DIR = path.join(__dirname, 'golden-corpus');

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function parseServerTiming(header: string | null | undefined): ReplayPhaseTiming[] {
  if (!header) return [];
  const phases: ReplayPhaseTiming[] = [];
  let cursor = 0;
  for (const entry of header.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [rawName, ...rest] = entry.split(';').map((s) => s.trim());
    const name = rawName;
    let durMs: number | undefined;
    for (const part of rest) {
      const [k, v] = part.split('=');
      if (k === 'dur' && v) {
        const n = Number(v);
        if (Number.isFinite(n)) durMs = n;
      }
    }
    const start = cursor;
    const end = durMs != null ? cursor + durMs : undefined;
    if (durMs != null) cursor = end!;
    phases.push({ phase: name, start_ms: start, end_ms: end, duration_ms: durMs });
  }
  return phases;
}

async function loadFixtures(): Promise<GoldenCorpusFixture[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(CORPUS_DIR);
  } catch {
    return [];
  }
  const out: GoldenCorpusFixture[] = [];
  for (const entry of entries.filter((e) => e.endsWith('.json'))) {
    try {
      const raw = await fs.readFile(path.join(CORPUS_DIR, entry), 'utf-8');
      const parsed = JSON.parse(raw) as GoldenCorpusFixture;
      out.push(parsed);
    } catch (err) {
      console.error(`[eval] skip ${entry}: ${(err as Error).message}`);
    }
  }
  return out;
}

async function replayTurn(
  gatewayUrl: string,
  fixture: GoldenCorpusFixture,
  turnIdx: number,
): Promise<ReplayTurnResult> {
  const turn = fixture.turns[turnIdx];
  const start = Date.now();
  try {
    // W1 baseline probe — hits admin health to measure round-trip latency.
    // W2+ swaps to a chat-turn endpoint once the eval harness is allowed to
    // exercise real conversational paths against staging.
    const resp = await fetch(`${gatewayUrl}/api/v1/admin/health`, {
      method: 'GET',
      headers: { 'x-eval-fixture': fixture.fixture_id, 'x-eval-turn': String(turn.turn) },
    });
    const totalMs = Date.now() - start;
    const phases = parseServerTiming(resp.headers.get('server-timing'));
    return {
      turn: turn.turn,
      ok: resp.ok,
      total_ms: totalMs,
      phases,
      http_status: resp.status,
    };
  } catch (err) {
    return {
      turn: turn.turn,
      ok: false,
      total_ms: Date.now() - start,
      phases: [],
      error: (err as Error).message,
    };
  }
}

async function replayFixture(
  gatewayUrl: string,
  fixture: GoldenCorpusFixture,
): Promise<ReplayFixtureResult> {
  const turnResults: ReplayTurnResult[] = [];
  for (let i = 0; i < fixture.turns.length; i++) {
    turnResults.push(await replayTurn(gatewayUrl, fixture, i));
  }
  const okTurns = turnResults.filter((t) => t.ok).map((t) => t.total_ms).sort((a, b) => a - b);
  return {
    fixture_id: fixture.fixture_id,
    ok: turnResults.every((t) => t.ok),
    turn_results: turnResults,
    p50_ms: percentile(okTurns, 50),
    p95_ms: percentile(okTurns, 95),
    p99_ms: percentile(okTurns, 99),
  };
}

export async function runReplay(
  gatewayUrl: string = DEFAULT_GATEWAY,
): Promise<ReplayRunOutput> {
  const startedAt = new Date().toISOString();
  const fixtures = await loadFixtures();
  const fixtureResults: ReplayFixtureResult[] = [];
  for (const fixture of fixtures) {
    fixtureResults.push(await replayFixture(gatewayUrl, fixture));
  }
  const allOkMs = fixtureResults.flatMap((f) => f.turn_results.filter((t) => t.ok).map((t) => t.total_ms))
    .sort((a, b) => a - b);
  return {
    run_id: randomUUID(),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    gateway_url: gatewayUrl,
    fixtures: fixtureResults,
    totals: {
      fixtures_total: fixtureResults.length,
      fixtures_ok: fixtureResults.filter((f) => f.ok).length,
      turns_total: fixtureResults.reduce((acc, f) => acc + f.turn_results.length, 0),
      turns_ok: fixtureResults.reduce((acc, f) => acc + f.turn_results.filter((t) => t.ok).length, 0),
      p50_ms: percentile(allOkMs, 50),
      p95_ms: percentile(allOkMs, 95),
      p99_ms: percentile(allOkMs, 99),
    },
  };
}

// Direct-invoke entry: `npx tsx services/gateway/test/eval/replay-runner.ts`
if (require.main === module) {
  runReplay()
    .then((out) => {
      console.log(JSON.stringify(out, null, 2));
    })
    .catch((err) => {
      console.error('[eval] runReplay failed:', err);
      process.exit(1);
    });
}
