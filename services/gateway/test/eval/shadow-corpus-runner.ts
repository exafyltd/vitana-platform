/**
 * Golden-corpus shadow-accuracy runner — Phase 1 (BOOTSTRAP-SHADOW-CORPUS-ACCURACY).
 *
 * Connects the labeled golden corpus (test/eval/golden-corpus/) to the shadow
 * comparison stack. Two modes:
 *
 *   --dry-run (default): load the corpus, simulate primary/candidate per
 *     labeled turn, score each against `expected_tool`, and print a
 *     ground-truth ACCURACY report — no network, fully deterministic per seed.
 *     This is the offline proof that the corpus → score → accuracy pipeline
 *     works end to end.
 *
 *   --emit: POST the labeled turns to the staging exerciser
 *     (POST /api/v1/admin/staging/eval/exercise-shadow, source=golden-corpus)
 *     so real eval.shadow.compared rows land in oasis_events and the
 *     shadow-comparison report surfaces accuracy. Requires GATEWAY_URL +
 *     GATEWAY_SERVICE_TOKEN; staging-only by the route's own guard.
 *
 * Run: `npx tsx test/eval/shadow-corpus-runner.ts [--emit] [--seed=YYYY-MM-DD]`
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GoldenCorpusFixture } from './types';
import { scoreGroundTruth, accuracyRollup } from '../../src/services/shadow-accuracy';

const CORPUS_DIR = path.join(__dirname, 'golden-corpus');

export interface LabeledTurn {
  user_input: string;
  expected_tool: string;
  fixture_id: string;
  turn: number;
}

/** Load every labeled turn (those carrying expected_tool) from the corpus. */
export function loadLabeledTurns(): LabeledTurn[] {
  const out: LabeledTurn[] = [];
  for (const file of fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json'))) {
    const fx = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, file), 'utf-8')) as GoldenCorpusFixture;
    for (const t of fx.turns) {
      if (t.expected_tool) {
        out.push({ user_input: t.user_input, expected_tool: t.expected_tool, fixture_id: fx.fixture_id, turn: t.turn });
      }
    }
  }
  return out;
}

// Deterministic hash → reproducible (seed, index) simulation, mirroring the
// gateway exerciser so the offline report matches what staging would emit.
function hashIdx(seed: string, idx: number, mod: number): number {
  let h = 5381;
  const s = `${seed}::${idx}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % mod;
}

export interface ScoredTurn {
  fixture_id: string;
  turn: number;
  expected: string;
  primary: string;
  candidate: string | null;
  primary_correct: boolean | null;
  candidate_correct: boolean | null;
}

/** Simulate + score one turn exactly as the gateway corpus exerciser does. */
export function simulateAndScore(turns: LabeledTurn[], seed: string): ScoredTurn[] {
  const toolPool = Array.from(new Set(turns.map((t) => t.expected_tool)));
  const wrongTool = (expected: string, i: number): string => {
    if (toolPool.length <= 1) return `${expected}__alt`;
    let pick = toolPool[hashIdx(`${seed}:wrong`, i, toolPool.length)];
    if (pick === expected) pick = toolPool[(toolPool.indexOf(expected) + 1) % toolPool.length];
    return pick;
  };
  return turns.map((t, i) => {
    const expected = t.expected_tool;
    const primaryOk = hashIdx(`${seed}:p-acc`, i, 100) >= 8;
    const candidateOk = hashIdx(`${seed}:c-acc`, i, 100) >= 14;
    const candidateWillError = hashIdx(`${seed}:c-err`, i, 100) < 3;
    const primaryTool = primaryOk ? expected : wrongTool(expected, i);
    const candidateTool = candidateWillError ? null : candidateOk ? expected : wrongTool(expected, i + 1);
    const score = scoreGroundTruth(expected, primaryTool, candidateTool);
    return {
      fixture_id: t.fixture_id,
      turn: t.turn,
      expected,
      primary: primaryTool,
      candidate: candidateTool,
      primary_correct: score.primary_correct,
      candidate_correct: score.candidate_correct,
    };
  });
}

async function emitToStaging(turns: LabeledTurn[], seed: string): Promise<void> {
  const base = process.env.GATEWAY_URL;
  const token = process.env.GATEWAY_SERVICE_TOKEN;
  if (!base || !token) throw new Error('--emit requires GATEWAY_URL and GATEWAY_SERVICE_TOKEN');
  const resp = await fetch(`${base.replace(/\/$/, '')}/api/v1/admin/staging/eval/exercise-shadow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ source: 'golden-corpus', prompt_seed: seed, corpus_turns: turns }),
  });
  const body = await resp.text();
  console.log(`[emit] HTTP ${resp.status}`);
  console.log(body);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const emit = args.includes('--emit');
  const seedArg = args.find((a) => a.startsWith('--seed='));
  const seed = seedArg ? seedArg.split('=')[1] : new Date().toISOString().slice(0, 10);

  const turns = loadLabeledTurns();
  console.log(`[shadow-corpus] loaded ${turns.length} labeled turns from golden corpus (seed=${seed})`);

  if (emit) {
    await emitToStaging(turns, seed);
    return;
  }

  const scored = simulateAndScore(turns, seed);
  const acc = accuracyRollup(scored);
  console.log(JSON.stringify({
    mode: 'dry-run',
    seed,
    labeled_comparisons: acc.labeled_comparisons,
    primary_accuracy: acc.primary_accuracy,
    candidate_accuracy: acc.candidate_accuracy,
    sample: scored.slice(0, 5),
  }, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
