/**
 * Developer Autopilot — Synthesis service (Stage A: ingest + dedup + rank)
 *
 * Takes raw signals from the scanner workflow and produces findings in
 * autopilot_recommendations with source_type='dev_autopilot'. Dedups by
 * fingerprint: repeat signals bump seen_count + last_seen_at on the existing
 * row rather than inserting a duplicate.
 *
 * PR-2 ships deterministic rule-based ranking. PR-3 layers a Managed Agent
 * planning stage on top (Stage B) — synthesis here is the data plumbing
 * that both stages share.
 */

import { createHash, randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';

const LOG_PREFIX = '[dev-autopilot-synthesis]';
const SCAN_VTID = 'VTID-DEV-AUTOPILOT';

// =============================================================================
// Types
// =============================================================================

export type SignalType =
  | 'todo'
  | 'large_file'
  | 'missing_tests'
  | 'dead_code'
  | 'duplication'
  | 'missing_docs'
  | 'circular_dep'
  | 'unused_dep'
  | 'cognitive_complexity'
  | 'safety_gap'
  // Scanner-registry PR: second wave of detectors (security, data-integrity,
  // dependencies, product-gap). See scripts/ci/scanners/registry.mjs for the
  // source of truth and maturity labels.
  | 'rls_gap'
  | 'schema_drift'
  | 'missing_auth'
  | 'secret_exposure'
  | 'cve'
  | 'stale_flag'
  | 'product_gap'
  // VTID-02866: voice-experience-scanner-v1 emissions land in autopilot_recommendations
  // with domain='voice' (after domainForPath edit below) and surface in the
  // Voice Improve cockpit briefing.
  | 'voice_health';

export type Severity = 'low' | 'medium' | 'high';

export interface DevAutopilotSignal {
  type: SignalType;
  severity: Severity;
  file_path: string;
  line_number?: number;
  message: string;
  suggested_action: string;
  scanner?: string;
  raw?: Record<string, unknown>;
}

export interface ScanInput {
  triggered_by?: string;
  signals: DevAutopilotSignal[];
  metadata?: Record<string, unknown>;
}

export interface ScanResult {
  ok: boolean;
  run_id?: string;
  signal_count?: number;
  new_finding_count?: number;
  updated_finding_count?: number;
  error?: string;
}

interface FindingRow {
  id: string;
  signal_fingerprint: string | null;
  seen_count: number | null;
  last_seen_at: string | null;
  status: string;
}

// =============================================================================
// Supabase helpers
// =============================================================================

interface SupaConfig {
  url: string;
  key: string;
}

function getSupabase(): SupaConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    console.error(`${LOG_PREFIX} missing SUPABASE_URL or SUPABASE_SERVICE_ROLE`);
    return null;
  }
  return { url, key };
}

async function supaRequest<T>(
  supa: SupaConfig,
  path: string,
  init: RequestInit = {}
): Promise<{ ok: boolean; data?: T; status: number; error?: string }> {
  const headers = {
    apikey: supa.key,
    Authorization: `Bearer ${supa.key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...(init.headers || {}),
  };
  try {
    const res = await fetch(`${supa.url}${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, status: res.status, error: body };
    }
    if (res.status === 204 || res.status === 201) {
      // Prefer: return=minimal produces 201 with an empty body — don't parse.
      const text = await res.text();
      if (!text) return { ok: true, status: res.status };
      try {
        return { ok: true, data: JSON.parse(text) as T, status: res.status };
      } catch { return { ok: true, status: res.status }; }
    }
    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status };
  } catch (err) {
    return { ok: false, status: 500, error: String(err) };
  }
}

// =============================================================================
// Fingerprinting (matches codebase-analyzer.ts semantics)
// =============================================================================

export function fingerprintSignal(signal: DevAutopilotSignal): string {
  const data = `dev_autopilot:${signal.type}:${signal.file_path}:${signal.line_number ?? 0}`;
  return createHash('sha256').update(data).digest('hex').substring(0, 16);
}

// =============================================================================
// Priority scoring (deterministic — PR-2 Stage A)
// =============================================================================

/** Maps severity to impact (1–10). Tuned so high > medium > low roughly 2x apart. */
const SEVERITY_IMPACT: Record<Severity, number> = { low: 3, medium: 6, high: 8 };

/** Effort estimate per signal type (1–10, lower is easier). */
const TYPE_EFFORT: Record<SignalType, number> = {
  dead_code: 2,
  unused_dep: 2,
  todo: 3,
  missing_docs: 3,
  missing_tests: 4,
  circular_dep: 5,
  duplication: 5,
  cognitive_complexity: 6,
  large_file: 7,
  // safety_gap items are infra-scoped integration tests — usually
  // ~half a day of work per gap.
  safety_gap: 6,
  // Scanner-registry wave: effort tuned so auto-approve picks up the easy
  // ones (secret rotation, CVE bump, stale flag delete) and leaves RLS /
  // schema-drift for humans by default.
  cve: 2,
  stale_flag: 2,
  secret_exposure: 3,
  missing_auth: 4,
  rls_gap: 5,
  schema_drift: 5,
  product_gap: 7,
  // VTID-02866: voice readiness fixes are usually small (mark not_wired
  // explicitly, add an oasis_topic, add an auth middleware, replace a
  // hardcoded speakingRate with getVoiceConfig()). Effort=4 keeps them
  // off auto-approve by default — the Voice Improve cockpit is the right
  // surface for human-supervised resolution.
  voice_health: 4,
};

/** Risk class for auto-exec eligibility — dead_code, unused_dep, missing_docs
 *  are safe refactors; large_file and duplication touch more surface area.
 */
const TYPE_RISK_CLASS: Record<SignalType, 'low' | 'medium' | 'high'> = {
  dead_code: 'low',
  unused_dep: 'low',
  missing_docs: 'low',
  todo: 'medium',
  missing_tests: 'medium',
  circular_dep: 'medium',
  duplication: 'medium',
  cognitive_complexity: 'medium',
  large_file: 'high',
  safety_gap: 'medium',
  // Scanner-registry wave:
  //   cve / stale_flag → low (small bumps, local effect)
  //   secret_exposure → high (exfil risk if wrong fix)
  //   missing_auth    → medium (could break a legit public route)
  //   rls_gap / schema_drift → medium (migration + code coordination)
  //   product_gap     → medium (LLM-proposed, human review advised)
  cve: 'low',
  stale_flag: 'low',
  secret_exposure: 'high',
  missing_auth: 'medium',
  rls_gap: 'medium',
  schema_drift: 'medium',
  product_gap: 'medium',
  // VTID-02866: voice readiness findings span multiple risk levels (missing
  // auth on a voice route is high; a hardcoded speakingRate is low). The
  // per-finding `severity` carries the gradient; risk_class default 'medium'
  // keeps voice_health off auto-approve until an operator inspects.
  voice_health: 'medium',
};

function scoreSignal(signal: DevAutopilotSignal): {
  impact_score: number;
  effort_score: number;
  risk_class: 'low' | 'medium' | 'high';
  auto_exec_eligible: boolean;
} {
  const impact = SEVERITY_IMPACT[signal.severity];
  const effort = TYPE_EFFORT[signal.type];
  const risk = TYPE_RISK_CLASS[signal.type];
  // Conservative triage: only low-risk findings with non-trivial impact
  // bypass the human-approval queue. Medium-risk signals (todo, missing_tests,
  // rls_gap, schema_drift, product_gap, ...) always require human review.
  // The dispatcher does a final destructive-op grep on the plan content
  // before actually executing, so this rule is the first of two gates.
  return {
    impact_score: impact,
    effort_score: effort,
    risk_class: risk,
    auto_exec_eligible: risk === 'low' && impact >= 5,
  };
}

function titleForSignal(signal: DevAutopilotSignal): string {
  const base = signal.file_path.split('/').pop() || signal.file_path;
  switch (signal.type) {
    case 'dead_code':     return `Remove dead code in ${base}`;
    case 'unused_dep':    return `Remove unused dependency (${base})`;
    case 'todo':          return `Address TODO/FIXME in ${base}`;
    case 'large_file':    return `Refactor large file ${base}`;
    case 'missing_tests': return `Add missing tests for ${base}`;
    case 'duplication':   return `Deduplicate code in ${base}`;
    case 'missing_docs':  return `Add missing docs for ${base}`;
    case 'circular_dep':  return `Break circular dependency via ${base}`;
    case 'cognitive_complexity': return `Reduce cognitive complexity in ${base}`;
    case 'safety_gap':    return signal.message.slice(0, 80);
    case 'rls_gap':       return `Missing RLS policy on ${base}`;
    case 'schema_drift':  return `Schema drift in ${base}`;
    case 'missing_auth':  return `Missing auth middleware in ${base}`;
    case 'secret_exposure': return `Hardcoded secret in ${base}`;
    case 'cve':           return `CVE: ${base}`;
    case 'stale_flag':    return `Stale feature flag — ${base}`;
    case 'product_gap':   return signal.message.slice(0, 80);
    // VTID-02866: voice-experience-scanner emissions. Use the scanner's own
    // message which already includes the specific signal/route/file context.
    case 'voice_health':  return signal.message.slice(0, 80);
    default:              return signal.message.substring(0, 80);
  }
}

// VTID-02866: voice-* prefixes resolve to 'voice' BEFORE the generic
// routes/services/frontend matchers. Without this, voice-experience-scanner
// findings land in domain='routes'|'services' and the Voice Improve
// briefing's `domain='voice'` filter returns zero rows.
const VOICE_PATH_PREFIXES = [
  'services/gateway/src/services/awareness-',
  'services/gateway/src/services/voice-',
  'services/gateway/src/services/orb-',
  'services/gateway/src/routes/voice-',
  'services/gateway/src/routes/orb-',
  'services/gateway/src/routes/awareness-',
  'services/gateway/src/frontend/command-hub/orb-widget',
  'scripts/ci/scanners/voice-experience-scanner',
];

function domainForPath(path: string): string {
  // VTID-02866: voice prefixes win first.
  for (const prefix of VOICE_PATH_PREFIXES) {
    if (path.startsWith(prefix)) return 'voice';
  }
  if (path.startsWith('services/gateway/src/routes/'))   return 'routes';
  if (path.startsWith('services/gateway/src/services/')) return 'services';
  if (path.startsWith('services/gateway/src/frontend/')) return 'frontend';
  if (path.startsWith('services/gateway/src/types/'))    return 'types';
  if (path.startsWith('services/agents/'))               return 'agents';
  if (path.startsWith('supabase/'))                      return 'database';
  return 'general';
}

// =============================================================================
// System-wide rollup rule
// =============================================================================
// When a single scanner emits a cluster of N findings of the same
// (signal_type, severity), the queue gets useless: an operator either
// approves all N (N PRs of the same trivial fix) or none (queue ignored).
// Either way it's friction.
//
// This is a system-level invariant: any cluster of ROLLUP_THRESHOLD or
// more signals from the same (scanner, signal_type, severity) collapses
// into ONE rollup finding before insert. Children land in
// raw.affected_files; the planner + worker pipeline reads that and writes
// one PR touching every file in the cluster.
//
// The rule lives here, in the synthesis layer, instead of in each scanner
// — so adding scanner #14 inherits the behaviour automatically.
const ROLLUP_THRESHOLD = Number.parseInt(process.env.AUTOPILOT_ROLLUP_THRESHOLD || '5', 10);

interface RollupGroup {
  scanner: string;
  signal_type: SignalType;
  severity: Severity;
  signals: DevAutopilotSignal[];
}

function groupSignalsForRollup(signals: DevAutopilotSignal[]): {
  passthrough: DevAutopilotSignal[];
  rollups: RollupGroup[];
} {
  const groups = new Map<string, RollupGroup>();
  for (const s of signals) {
    const scanner = s.scanner || 'unknown';
    const key = `${scanner}|${s.type}|${s.severity}`;
    let g = groups.get(key);
    if (!g) {
      g = { scanner, signal_type: s.type, severity: s.severity, signals: [] };
      groups.set(key, g);
    }
    g.signals.push(s);
  }
  const passthrough: DevAutopilotSignal[] = [];
  const rollups: RollupGroup[] = [];
  for (const g of groups.values()) {
    if (g.signals.length >= ROLLUP_THRESHOLD) rollups.push(g);
    else passthrough.push(...g.signals);
  }
  return { passthrough, rollups };
}

function buildRollupSignal(g: RollupGroup): DevAutopilotSignal {
  // Sort children by file_path for stable fingerprinting + readable lists.
  const sorted = [...g.signals].sort((a, b) => (a.file_path || '').localeCompare(b.file_path || ''));
  const previewFiles = sorted.slice(0, 6).map(s => s.file_path).filter(Boolean);
  const moreNote = sorted.length > 6 ? ` (+${sorted.length - 6} more)` : '';
  const anchorFile = sorted[0]?.file_path || '(rollup)';
  const anchorLine = sorted[0]?.line_number || 1;

  // Combine the children's suggested actions when distinct, otherwise use
  // the first one's text — most scanners emit identical suggestions per
  // signal in a cluster, so dedup keeps the message tight.
  const distinctActions = Array.from(new Set(sorted.map(s => s.suggested_action).filter(Boolean)));
  const action = distinctActions.length === 1
    ? distinctActions[0]
    : `Apply the same fix class to every file in raw.affected_files (typically a one-line change per file). Children's suggestions: ${distinctActions.slice(0, 3).join(' | ')}${distinctActions.length > 3 ? ' …' : ''}`;

  return {
    type: g.signal_type,
    severity: g.severity,
    file_path: anchorFile,
    line_number: anchorLine,
    message: `[rollup] ${g.scanner} flagged ${sorted.length} files with the same fix class (${g.signal_type}). Files: ${previewFiles.join(', ')}${moreNote}.`,
    suggested_action: action || 'See raw.affected_files for the per-file fix list.',
    scanner: g.scanner,
    raw: {
      rollup: true,
      total_files: sorted.length,
      affected_files: sorted.map(s => ({
        file_path: s.file_path,
        line_number: s.line_number,
        message: s.message,
        suggested_action: s.suggested_action,
        raw: s.raw || {},
      })),
    },
  };
}

// =============================================================================
// Core: ingest a scan — dedup + upsert findings
// =============================================================================

export async function ingestScan(input: ScanInput): Promise<ScanResult> {
  const supa = getSupabase();
  if (!supa) return { ok: false, error: 'Gateway misconfigured: Supabase credentials missing' };

  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // 1. Create run row
  const runCreate = await supaRequest(supa, '/rest/v1/dev_autopilot_runs', {
    method: 'POST',
    body: JSON.stringify({
      run_id: runId,
      started_at: startedAt,
      status: 'ingesting',
      signal_count: input.signals.length,
      triggered_by: input.triggered_by || 'api',
      metadata: input.metadata || {},
    }),
  });
  if (!runCreate.ok) {
    return { ok: false, error: `run insert failed: ${runCreate.error}` };
  }

  await emitOasisEvent({
    vtid: SCAN_VTID,
    type: 'dev_autopilot.scan.started',
    source: 'dev-autopilot',
    status: 'info',
    message: `Dev Autopilot scan ${runId.slice(0, 8)} started with ${input.signals.length} signals`,
    payload: { run_id: runId, signal_count: input.signals.length, triggered_by: input.triggered_by },
  });

  // 2. Persist raw signals (for audit + dedup traceability) — one row per
  // RAW signal, before rollup. Audit always sees the full pre-collapse list.
  if (input.signals.length > 0) {
    const signalRows = input.signals.map(s => ({
      run_id: runId,
      type: s.type,
      severity: s.severity,
      file_path: s.file_path,
      line_number: s.line_number ?? null,
      message: s.message,
      suggested_action: s.suggested_action,
      fingerprint: fingerprintSignal(s),
      scanner: s.scanner ?? null,
      raw: s.raw ?? {},
    }));
    const sigInsert = await supaRequest(supa, '/rest/v1/dev_autopilot_signals', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(signalRows),
    });
    if (!sigInsert.ok) {
      console.warn(`${LOG_PREFIX} signals insert failed (non-fatal): ${sigInsert.error}`);
    }
  }

  // 2b. System-wide rollup. Group raw signals by (scanner, signal_type, severity);
  // any cluster ≥ ROLLUP_THRESHOLD becomes one synthetic rollup signal that
  // replaces the cluster in the dedup-and-upsert loop below. Small clusters
  // pass through unchanged. The rollup signal carries the full child list in
  // raw.affected_files for downstream planning.
  const { passthrough, rollups } = groupSignalsForRollup(input.signals);
  const effectiveSignals: DevAutopilotSignal[] = [
    ...passthrough,
    ...rollups.map(g => buildRollupSignal(g)),
  ];
  if (rollups.length > 0) {
    console.log(
      `${LOG_PREFIX} rollup applied: ${rollups.length} cluster(s) collapsed `
      + `(${rollups.reduce((acc, g) => acc + g.signals.length, 0)} signals → ${rollups.length} rollup findings, `
      + `threshold=${ROLLUP_THRESHOLD})`,
    );
  }

  // 3. Dedup + upsert findings
  let newCount = 0;
  let updatedCount = 0;
  const now = new Date().toISOString();

  for (const signal of effectiveSignals) {
    const fingerprint = fingerprintSignal(signal);
    // Lookup existing live finding with this fingerprint
    const existing = await supaRequest<FindingRow[]>(
      supa,
      `/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot&signal_fingerprint=eq.${fingerprint}&status=in.(new,snoozed)&select=id,seen_count,last_seen_at,status&limit=1`,
    );
    if (!existing.ok) {
      console.warn(`${LOG_PREFIX} lookup failed for ${fingerprint}: ${existing.error}`);
      continue;
    }
    const hit = (existing.data || [])[0];
    if (hit) {
      // Bump seen_count + last_seen_at
      const bumped = await supaRequest(supa, `/rest/v1/autopilot_recommendations?id=eq.${hit.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          seen_count: (hit.seen_count || 1) + 1,
          last_seen_at: now,
          updated_at: now,
          source_run_id: runId,
        }),
      });
      if (bumped.ok) updatedCount++;
      continue;
    }

    // Insert new finding
    const score = scoreSignal(signal);
    const title = titleForSignal(signal);
    const domain = domainForPath(signal.file_path);
    const inserted = await supaRequest(supa, '/rest/v1/autopilot_recommendations', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        title,
        summary: signal.message,
        domain,
        risk_level: score.risk_class,
        risk_class: score.risk_class,
        impact_score: score.impact_score,
        effort_score: score.effort_score,
        status: 'new',
        source_type: 'dev_autopilot',
        source_run_id: runId,
        auto_exec_eligible: score.auto_exec_eligible,
        signal_fingerprint: fingerprint,
        first_seen_at: now,
        last_seen_at: now,
        seen_count: 1,
        spec_snapshot: {
          signal_type: signal.type,
          file_path: signal.file_path,
          line_number: signal.line_number,
          suggested_action: signal.suggested_action,
          scanner: signal.scanner,
          // Propagate scanner-specific metadata (file_loc for missing_tests,
          // gap_key/expected_test_file for safety_gap, etc.) into the
          // snapshot so downstream consumers (bulk-archive SQL, auto-approve
          // filter) can read them without a separate lookup.
          ...(signal.raw || {}),
        },
      }),
    });
    if (inserted.ok) newCount++;
  }

  // 4. Finalize run
  const completedAt = new Date().toISOString();
  await supaRequest(supa, `/rest/v1/dev_autopilot_runs?run_id=eq.${runId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'done',
      completed_at: completedAt,
      new_finding_count: newCount,
      updated_finding_count: updatedCount,
    }),
  });

  await emitOasisEvent({
    vtid: SCAN_VTID,
    type: 'dev_autopilot.scan.completed',
    source: 'dev-autopilot',
    status: 'success',
    message: `Dev Autopilot scan ${runId.slice(0, 8)}: ${newCount} new, ${updatedCount} updated`,
    payload: { run_id: runId, new: newCount, updated: updatedCount, total_signals: input.signals.length },
  });

  // 5. Eager Stage B — plan the top K new findings so the UI has actionable
  //    cards immediately. Remaining findings get lazy planning on expand/approve.
  //    FIRE-AND-FORGET: each Managed Agent session takes 30-120s. Awaiting K
  //    of them sequentially pushes the /scan POST over Cloud Run's 5-min
  //    request timeout (BOOTSTRAP-SCAN-TIMEOUT). The UI's lazy planner
  //    already handles the case where a finding has no plan yet.
  if (newCount > 0) {
    const eagerK = parseInt(process.env.DEV_AUTOPILOT_EAGER_PLAN_TOP_K || '5', 10);
    if (eagerK > 0) {
      import('./dev-autopilot-planning').then((planning) => {
        return (planning as { eagerlyPlanTopK: (runId: string, k: number) => Promise<{ planned: number; errors: number }> })
          .eagerlyPlanTopK(runId, eagerK);
      }).then((eagerResult) => {
        console.log(`${LOG_PREFIX} eager plan: ${eagerResult.planned} planned, ${eagerResult.errors} errors`);
      }).catch((err) => {
        console.warn(`${LOG_PREFIX} eager planning failed (non-fatal):`, err);
      });
    }
  }

  return {
    ok: true,
    run_id: runId,
    signal_count: input.signals.length,
    new_finding_count: newCount,
    updated_finding_count: updatedCount,
  };
}

// =============================================================================
// Scoring helpers exposed for tests + Stage B (planning)
// =============================================================================

export { scoreSignal, titleForSignal, domainForPath, SEVERITY_IMPACT, TYPE_RISK_CLASS };
export { LOG_PREFIX };
