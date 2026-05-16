/**
 * VTID-03025: LiveKit hourly tests — orchestrator.
 *
 * Loads enabled cases from `livekit_test_cases`, evaluates each via the
 * dry-run evaluator, scores against the golden contract, and writes one
 * row per case to `livekit_test_results` plus a summary row to
 * `livekit_test_runs`.
 *
 * Behavior:
 *   - Cases are evaluated SERIALLY. Hourly cadence × ~13 cases × ~3-5s
 *     each = ~40-65s end-to-end. Acceptable for synchronous cron POSTs.
 *   - One automatic retry per case when the first attempt fails
 *     (status='failed', not 'errored'). The second attempt's outcome is
 *     authoritative; the result row carries `retried=true`.
 *   - Errors during evaluation (network, auth, throw) → status='errored'
 *     with the error message captured. No retry on errored — those need
 *     human diagnosis.
 *   - The run row is created BEFORE the first case so partial progress
 *     is observable. Totals are updated at the end.
 *
 * No tool execution. Side-effect free at the tool layer. The only DB
 * writes are the runner's own bookkeeping rows in `livekit_test_*`.
 */

import { getSupabase } from '../../lib/supabase';
import {
  evaluateLiveKitDryRun,
  type DryRunEvalResult,
  type DryRunIdentity,
} from './livekit-test-eval';
import {
  scoreResult,
  type ExpectedContract,
  type ScoreOutcome,
} from './livekit-test-scorer';

export type RunTrigger = 'manual' | 'cron' | 'admin' | 'test';

export interface RunOptions {
  trigger: RunTrigger;
  /** Restrict to a single case by key (debug / one-off). */
  caseKey?: string;
  /** Override identity for the run (e.g. admin testing as another user). */
  identity?: Partial<DryRunIdentity>;
  /** Layer filter. Slice 1a only ships Layer A. */
  layer?: 'A' | 'B';
}

export interface CaseRow {
  id: string;
  key: string;
  label: string;
  prompt: string;
  expected: ExpectedContract;
  layer: 'A' | 'B';
  enabled: boolean;
}

export interface PersistedResult {
  case_id: string;
  case_key: string;
  status: 'passed' | 'failed' | 'errored';
  tool_calls: DryRunEvalResult['tool_calls'] | null;
  reply_text: string | null;
  failure_reasons: string[] | null;
  error: string | null;
  latency_ms: number | null;
  instruction_chars: number | null;
  retried: boolean;
}

export interface RunSummary {
  run_id: string;
  trigger: RunTrigger;
  layer: 'A' | 'B';
  started_at: string;
  finished_at: string;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  duration_ms: number;
  results: PersistedResult[];
}

/**
 * Run all enabled cases (or a single case if `caseKey` is provided).
 * Throws if Supabase is not configured or the run cannot be created;
 * per-case errors are captured and stored, not thrown.
 */
export async function runLiveKitTestSuite(
  opts: RunOptions,
): Promise<RunSummary> {
  const sb = getSupabase();
  if (!sb) {
    throw new Error('runLiveKitTestSuite: Supabase client not configured');
  }
  const layer = opts.layer ?? 'A';

  // 1. Load cases.
  const cases = await loadCases(opts.caseKey, layer);
  if (cases.length === 0) {
    throw new Error(
      opts.caseKey
        ? `runLiveKitTestSuite: no enabled case with key="${opts.caseKey}"`
        : `runLiveKitTestSuite: no enabled cases for layer="${layer}"`,
    );
  }

  // 2. Create the run row (so partial progress is observable).
  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();
  const insertRun = await sb
    .from('livekit_test_runs')
    .insert({
      started_at: startedAtIso,
      layer,
      trigger: opts.trigger,
      total: cases.length,
    })
    .select('id')
    .single();

  if (insertRun.error || !insertRun.data) {
    throw new Error(
      `runLiveKitTestSuite: failed to create run row: ${insertRun.error?.message ?? 'unknown'}`,
    );
  }
  const runId: string = (insertRun.data as { id: string }).id;

  // 3. Execute cases serially.
  const results: PersistedResult[] = [];
  for (const c of cases) {
    const persisted = await runOneCase(c, runId, opts.identity);
    results.push(persisted);
  }

  // 4. Aggregate + finalize.
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'errored').length;
  const finishedAtMs = Date.now();
  const durationMs = finishedAtMs - startedAtMs;
  const finishedAtIso = new Date(finishedAtMs).toISOString();

  await sb
    .from('livekit_test_runs')
    .update({
      finished_at: finishedAtIso,
      passed,
      failed,
      errored,
      duration_ms: durationMs,
    })
    .eq('id', runId);

  return {
    run_id: runId,
    trigger: opts.trigger,
    layer,
    started_at: startedAtIso,
    finished_at: finishedAtIso,
    total: cases.length,
    passed,
    failed,
    errored,
    duration_ms: durationMs,
    results,
  };
}

async function runOneCase(
  c: CaseRow,
  runId: string,
  identity: Partial<DryRunIdentity> | undefined,
): Promise<PersistedResult> {
  const sb = getSupabase();
  if (!sb) {
    throw new Error('runOneCase: Supabase client not configured');
  }

  const caseStartedAtIso = new Date().toISOString();

  // Attempt 1
  const attempt1 = await safeEvalAndScore(c.prompt, c.expected, identity);

  let final = attempt1;
  let retried = false;

  // Retry once on 'failed' (not 'errored'). One retry buys us a flake buffer
  // for LLM variance without doubling cost across the whole grid.
  if (attempt1.kind === 'scored' && attempt1.outcome.status === 'failed') {
    retried = true;
    const attempt2 = await safeEvalAndScore(c.prompt, c.expected, identity);
    final = attempt2;
  }

  const finishedAtIso = new Date().toISOString();

  const row = projectToPersisted(c, final, retried);

  await sb.from('livekit_test_results').insert({
    run_id: runId,
    case_id: c.id,
    case_key: c.key,
    status: row.status,
    tool_calls: row.tool_calls,
    reply_text: row.reply_text,
    expected: c.expected,
    failure_reasons: row.failure_reasons,
    error: row.error,
    latency_ms: row.latency_ms,
    instruction_chars: row.instruction_chars,
    retried: row.retried,
    started_at: caseStartedAtIso,
    finished_at: finishedAtIso,
  });

  return row;
}

type AttemptOutcome =
  | { kind: 'scored'; evalResult: DryRunEvalResult; outcome: ScoreOutcome }
  | { kind: 'errored'; error: string };

async function safeEvalAndScore(
  prompt: string,
  expected: ExpectedContract,
  identity: Partial<DryRunIdentity> | undefined,
): Promise<AttemptOutcome> {
  try {
    const evalResult = await evaluateLiveKitDryRun({ prompt, identity });
    const outcome = scoreResult(
      { tool_calls: evalResult.tool_calls, reply_text: evalResult.reply_text },
      expected,
    );
    return { kind: 'scored', evalResult, outcome };
  } catch (err) {
    return {
      kind: 'errored',
      error: (err as Error).message ?? String(err),
    };
  }
}

function projectToPersisted(
  c: CaseRow,
  final: AttemptOutcome,
  retried: boolean,
): PersistedResult {
  if (final.kind === 'errored') {
    return {
      case_id: c.id,
      case_key: c.key,
      status: 'errored',
      tool_calls: null,
      reply_text: null,
      failure_reasons: null,
      error: final.error,
      latency_ms: null,
      instruction_chars: null,
      retried,
    };
  }

  return {
    case_id: c.id,
    case_key: c.key,
    status: final.outcome.status,
    tool_calls: final.evalResult.tool_calls,
    reply_text: final.evalResult.reply_text,
    failure_reasons:
      final.outcome.failure_reasons.length > 0
        ? final.outcome.failure_reasons
        : null,
    error: null,
    latency_ms: final.evalResult.latency_ms,
    instruction_chars: final.evalResult.instruction_chars,
    retried,
  };
}

async function loadCases(
  caseKey: string | undefined,
  layer: 'A' | 'B',
): Promise<CaseRow[]> {
  const sb = getSupabase();
  if (!sb) throw new Error('loadCases: Supabase client not configured');

  let query = sb
    .from('livekit_test_cases')
    .select('id, key, label, prompt, expected, layer, enabled')
    .eq('enabled', true)
    .eq('layer', layer);

  if (caseKey) {
    query = query.eq('key', caseKey);
  }

  const { data, error } = await query.order('key', { ascending: true });

  if (error) {
    throw new Error(`loadCases: ${error.message}`);
  }

  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id as string,
    key: r.key as string,
    label: r.label as string,
    prompt: r.prompt as string,
    expected: r.expected as ExpectedContract,
    layer: r.layer as 'A' | 'B',
    enabled: r.enabled as boolean,
  }));
}

/**
 * Read API for the monitor panel: recent runs (paginated).
 */
export async function listRecentRuns(limit = 50): Promise<Array<{
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: RunTrigger;
  layer: string;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  duration_ms: number | null;
}>> {
  const sb = getSupabase();
  if (!sb) throw new Error('listRecentRuns: Supabase client not configured');
  const { data, error } = await sb
    .from('livekit_test_runs')
    .select('id, started_at, finished_at, trigger, layer, total, passed, failed, errored, duration_ms')
    .order('started_at', { ascending: false })
    .limit(Math.min(limit, 200));
  if (error) throw new Error(`listRecentRuns: ${error.message}`);
  return (data ?? []) as Array<{
    id: string;
    started_at: string;
    finished_at: string | null;
    trigger: RunTrigger;
    layer: string;
    total: number;
    passed: number;
    failed: number;
    errored: number;
    duration_ms: number | null;
  }>;
}

/**
 * Read API for the monitor panel: full results for one run.
 */
export async function getRunDetail(runId: string): Promise<{
  run: {
    id: string;
    started_at: string;
    finished_at: string | null;
    trigger: RunTrigger;
    layer: string;
    total: number;
    passed: number;
    failed: number;
    errored: number;
    duration_ms: number | null;
  };
  results: Array<{
    case_key: string;
    status: 'passed' | 'failed' | 'errored';
    tool_calls: unknown;
    reply_text: string | null;
    expected: unknown;
    failure_reasons: string[] | null;
    error: string | null;
    latency_ms: number | null;
    retried: boolean;
    started_at: string;
    finished_at: string | null;
  }>;
} | null> {
  const sb = getSupabase();
  if (!sb) throw new Error('getRunDetail: Supabase client not configured');

  const { data: runRow, error: runErr } = await sb
    .from('livekit_test_runs')
    .select('id, started_at, finished_at, trigger, layer, total, passed, failed, errored, duration_ms')
    .eq('id', runId)
    .maybeSingle();
  if (runErr) throw new Error(`getRunDetail: ${runErr.message}`);
  if (!runRow) return null;

  const { data: resultRows, error: resErr } = await sb
    .from('livekit_test_results')
    .select(
      'case_key, status, tool_calls, reply_text, expected, failure_reasons, error, latency_ms, retried, started_at, finished_at',
    )
    .eq('run_id', runId)
    .order('case_key', { ascending: true });
  if (resErr) throw new Error(`getRunDetail: ${resErr.message}`);

  return {
    run: runRow as {
      id: string;
      started_at: string;
      finished_at: string | null;
      trigger: RunTrigger;
      layer: string;
      total: number;
      passed: number;
      failed: number;
      errored: number;
      duration_ms: number | null;
    },
    results: (resultRows ?? []) as Array<{
      case_key: string;
      status: 'passed' | 'failed' | 'errored';
      tool_calls: unknown;
      reply_text: string | null;
      expected: unknown;
      failure_reasons: string[] | null;
      error: string | null;
      latency_ms: number | null;
      retried: boolean;
      started_at: string;
      finished_at: string | null;
    }>,
  };
}

/**
 * Read API for the monitor panel: list cases (for showing what's enabled).
 */
export async function listCases(): Promise<Array<{
  id: string;
  key: string;
  label: string;
  prompt: string;
  layer: string;
  enabled: boolean;
  notes: string | null;
}>> {
  const sb = getSupabase();
  if (!sb) throw new Error('listCases: Supabase client not configured');
  const { data, error } = await sb
    .from('livekit_test_cases')
    .select('id, key, label, prompt, layer, enabled, notes')
    .order('key', { ascending: true });
  if (error) throw new Error(`listCases: ${error.message}`);
  return (data ?? []) as Array<{
    id: string;
    key: string;
    label: string;
    prompt: string;
    layer: string;
    enabled: boolean;
    notes: string | null;
  }>;
}
