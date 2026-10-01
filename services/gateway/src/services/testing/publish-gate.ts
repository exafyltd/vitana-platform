/**
 * VTID-04646 — Testing & QA rebuild P5a: the PUBLISH gate.
 *
 * Owner decision (2026-09-26): PUBLISH refuses to promote a staging build
 * whose STAGING-VERIFY run did not pass (CLAUDE.md rules 46–50). An exafy
 * admin can still publish by writing down why; the reason is recorded in
 * OASIS with the publish.
 *
 * The check is per COMMIT, not "the latest run": staging serves one commit,
 * and only a run for that exact commit says anything about it. A run that
 * reported `superseded` means staging moved on mid-run, so it proves nothing
 * about the commit either. A lookup that fails blocks too (fail closed) —
 * the override is the way through, not a silent pass.
 */
import { getSupabase } from '../../lib/supabase';

export type StagingVerifyOutcome = 'passed' | 'failed' | 'superseded' | 'unknown';

export interface StagingVerification {
  service: string;
  commit: string;
  outcome: StagingVerifyOutcome;
  at: string | null;
  run_url: string | null;
  failed_tests: Array<{ suite?: string; name?: string }>;
}

export interface PublishGateDecision {
  allowed: boolean;
  /** verified — a passing run for this commit; overridden — admin gave a reason; blocked — neither. */
  status: 'verified' | 'overridden' | 'blocked' | 'disabled';
  /** Why a publish without override is refused. Empty when verified. */
  reason: string;
  override_reason: string | null;
  verification: StagingVerification | null;
}

export const OVERRIDE_REASON_MIN = 10;
export const OVERRIDE_REASON_MAX = 500;

/** Kill switch: PUBLISH_REQUIRE_STAGING_VERIFY=false turns the gate off (recorded as `disabled`). */
export function isPublishGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PUBLISH_REQUIRE_STAGING_VERIFY !== 'false';
}

export function normalizeOverrideReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const reason = raw.trim().replace(/\s+/g, ' ');
  if (reason.length < OVERRIDE_REASON_MIN) return null;
  return reason.slice(0, OVERRIDE_REASON_MAX);
}

/** Map one oasis_events row (topic staging.verify.*) to a verification. */
export function toVerification(row: { topic?: string; created_at?: string; metadata?: unknown }): StagingVerification {
  const m = (row.metadata || {}) as Record<string, any>;
  const raw = String(row.topic || '').replace('staging.verify.', '');
  const outcome: StagingVerifyOutcome = raw === 'passed' || raw === 'failed' || raw === 'superseded' ? raw : 'unknown';
  const results = Array.isArray(m.results) ? m.results : [];
  return {
    service: String(m.service || 'unknown'),
    commit: String(m.commit || ''),
    outcome,
    at: row.created_at || null,
    run_url: typeof m.run_url === 'string' ? m.run_url : null,
    failed_tests: results.filter((r: any) => r && r.ok === false).map((r: any) => ({ suite: r.suite, name: r.name })),
  };
}

/**
 * Pure decision. `lookupError` is set when the verification could not be read.
 */
export function decidePublishGate(input: {
  enabled: boolean;
  commit: string;
  verification: StagingVerification | null;
  lookupError?: string | null;
  overrideReason?: unknown;
}): PublishGateDecision {
  const override = normalizeOverrideReason(input.overrideReason);
  const v = input.verification;
  if (!input.enabled) {
    return { allowed: true, status: 'disabled', reason: 'PUBLISH_REQUIRE_STAGING_VERIFY=false', override_reason: override, verification: v };
  }
  if (v && v.outcome === 'passed' && v.commit === input.commit) {
    return { allowed: true, status: 'verified', reason: '', override_reason: null, verification: v };
  }
  const short = input.commit.slice(0, 7);
  let reason: string;
  if (input.lookupError) {
    reason = `Could not read the staging verification for ${short}: ${input.lookupError}`;
  } else if (!v) {
    reason = `No STAGING-VERIFY run has reported on ${short} yet.`;
  } else if (v.outcome === 'failed') {
    const names = v.failed_tests.slice(0, 5).map((t) => t.name || t.suite || '?').join(', ');
    reason = `STAGING-VERIFY failed on ${short}${names ? ` (${names})` : ''}.`;
  } else if (v.outcome === 'superseded') {
    reason = `The STAGING-VERIFY run for ${short} was superseded before it finished, so nothing about this commit was verified.`;
  } else {
    reason = `STAGING-VERIFY reported an unrecognised outcome for ${short}.`;
  }
  if (override) {
    return { allowed: true, status: 'overridden', reason, override_reason: override, verification: v };
  }
  return { allowed: false, status: 'blocked', reason, override_reason: null, verification: v };
}

export interface PublishGateDeps {
  /** Newest-first staging.verify.* rows for this service and commit. */
  fetchRows(service: string, commit: string): Promise<Array<{ topic?: string; created_at?: string; metadata?: unknown }>>;
}

export function supabasePublishGateDeps(): PublishGateDeps | null {
  const supabase = getSupabase();
  if (!supabase) return null;
  return {
    async fetchRows(service, commit) {
      const { data, error } = await supabase
        .from('oasis_events')
        .select('created_at, topic, metadata')
        .like('topic', 'staging.verify.%')
        .eq('metadata->>service', service)
        .eq('metadata->>commit', commit)
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) throw new Error(error.message);
      return data || [];
    },
  };
}

/** Look up the latest verification for `commit` and decide. Never throws. */
export async function evaluatePublishGate(opts: {
  commit: string;
  service?: string;
  overrideReason?: unknown;
  deps?: PublishGateDeps | null;
  env?: NodeJS.ProcessEnv;
}): Promise<PublishGateDecision> {
  const enabled = isPublishGateEnabled(opts.env);
  const service = opts.service || 'gateway';
  if (!enabled) return decidePublishGate({ enabled, commit: opts.commit, verification: null, overrideReason: opts.overrideReason });
  const deps = opts.deps === undefined ? supabasePublishGateDeps() : opts.deps;
  if (!deps) {
    return decidePublishGate({ enabled, commit: opts.commit, verification: null, lookupError: 'Supabase not configured', overrideReason: opts.overrideReason });
  }
  try {
    const rows = await deps.fetchRows(service, opts.commit);
    const verification = rows.length ? toVerification(rows[0]) : null;
    return decidePublishGate({ enabled, commit: opts.commit, verification, overrideReason: opts.overrideReason });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return decidePublishGate({ enabled, commit: opts.commit, verification: null, lookupError: msg, overrideReason: opts.overrideReason });
  }
}
