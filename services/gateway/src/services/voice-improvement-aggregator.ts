/**
 * VTID-02865: Voice Improvement aggregator.
 *
 * Fans out parallel queries across every voice-experience signal source
 * and produces a single ranked queue of action items + a composite quality
 * score, mirroring the ops-action-required.ts pattern (parallel fetch +
 * dedup + sort + cap).
 *
 * Sources (each returns ActionItem[]):
 *   1. voice_healing_quarantine (status='quarantined')
 *   2. voice_architecture_reports (status='open' AND track != 'stay_and_patch')
 *   3. Awareness watchdogs — fail (live signals only) AND unknown
 *   4. Awareness manifest — wired === 'not_wired' (excluding enforcement_pending)
 *   5. self_healing_log (escalated|rolled_back, last 24h)
 *   6. autopilot_recommendations (status='new', domain='voice')
 *      [populated only after PR B's domainForPath edit]
 *   7. Provider drift + failure-classes-without-rule (DB checks moved
 *      from PR B's scanner because they need runtime DB access)
 *
 * Read-only and side-effect-free. Caller is the GET /briefing route.
 */

import {
  getWatchdogStatuses,
  type WatchdogStatus,
} from './awareness-watchdogs';
import { getManifest as getAwarenessManifest } from './awareness-registry';
import { IMPLEMENTED_TTS_PROVIDERS, IMPLEMENTED_STT_PROVIDERS } from './voice-config';
import { ENDPOINT_FILE_MAP } from '../types/self-healing';

const ITEM_LOOKBACK_HOURS = 24;
const MAX_ITEMS_DEFAULT = 20;

// VTID-02953 (PR-K): zombie filter for the Improve cockpit.
// Escalations against endpoints that are no longer registered (route retired
// in a PR, e.g. PR-I deleted /api/v1/self-healing/canary/failing-health) show
// up as `route_not_registered` forever and pollute the actionable queue.
// Skip them: the underlying endpoint is gone, so manual investigation is
// pointless. Real route_not_registered escalations (against endpoints still
// in ENDPOINT_FILE_MAP) still surface — the deletion is the legitimate fix.
export function isZombieEscalation(endpoint: string, failureClass: string | null): boolean {
  if (failureClass === 'route_not_registered' && !ENDPOINT_FILE_MAP[endpoint]) {
    return true;
  }
  // dev_autopilot_safety_gate_blocked against synthetic autopilot.* endpoints
  // (not real route paths) — these are dev-autopilot finding artifacts that
  // tend to accumulate when the safety gate refuses a bridge. They have no
  // route to fix; surface them via the dev-autopilot recommendations panel
  // instead, not the self-healing escalation list.
  if (
    failureClass === 'dev_autopilot_safety_gate_blocked' &&
    endpoint.startsWith('autopilot.')
  ) {
    return true;
  }
  return false;
}

export type ActionSeverity = 'critical' | 'warning' | 'info';

export type ActionSource =
  | 'healing_quarantine'
  | 'architecture_report'
  | 'watchdog_failed'
  | 'watchdog_unknown'
  | 'awareness_not_wired'
  | 'self_healing_escalation'
  | 'self_healing_win' // VTID-02953 (PR-K): positive surface for completed autonomous self-heals
  | 'autopilot_recommendation'
  | 'provider_drift'
  | 'failure_class_no_rule';

export type ActionVerb =
  | 'investigate'
  | 'create_vtid'
  | 'accept_execute'
  | 'snooze'
  | 'reject'
  | 'open_in_self_healing';

export interface ActionItem {
  id: string; // dedup key, composed: `${source}:${ref_id}`
  source: ActionSource;
  severity: ActionSeverity;
  title: string;
  description: string;
  evidence: Array<{ kind: string; ref: string; snippet?: string }>;
  affected_sessions: number | null;
  affected_cohort: string | null;
  likely_owner: string | null;
  source_files: string[];
  confidence: number; // 0..1
  recommended_action: string;
  available_actions: ActionVerb[];
  source_ref: { table: string; id: string };
  detected_at: string;
}

export interface VoiceImprovementBriefing {
  generated_at: string;
  quality_score: number;
  summary: {
    total_action_items: number;
    critical: number;
    warning: number;
    info: number;
    by_source: Record<ActionSource, number>;
  };
  action_items: ActionItem[];
  voice_session_health: {
    sessions_observed: number;
    audio_in_zero_count: number;
    one_way_count: number;
    audio_in_zero_ratio: number;
    one_way_ratio: number;
  };
  generated_in_ms: number;
}

interface SupabaseConfig {
  url: string;
  key: string;
}

function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return { url, key };
}

function authHeaders(cfg: SupabaseConfig): Record<string, string> {
  return { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };
}

// ---------------------------------------------------------------------------
// composeQualityScore — pure function, unit-tested.
// Start at 100, subtract 15 per critical, 5 per warning, 1 per info, floor 0.
// ---------------------------------------------------------------------------
export function composeQualityScore(items: ActionItem[]): number {
  let score = 100;
  for (const it of items) {
    if (it.severity === 'critical') score -= 15;
    else if (it.severity === 'warning') score -= 5;
    else if (it.severity === 'info') score -= 1;
  }
  return Math.max(0, score);
}

// ---------------------------------------------------------------------------
// Source 1: voice_healing_quarantine
// ---------------------------------------------------------------------------
async function fetchQuarantines(cfg: SupabaseConfig): Promise<ActionItem[]> {
  try {
    const r = await fetch(
      `${cfg.url}/rest/v1/voice_healing_quarantine?status=eq.quarantined&select=class,normalized_signature,quarantined_at,reason&order=quarantined_at.desc&limit=50`,
      { headers: authHeaders(cfg) },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{
      class: string;
      normalized_signature: string | null;
      quarantined_at: string;
      reason: string | null;
    }>;
    return rows.map((row) => ({
      id: `healing_quarantine:${row.class}:${row.normalized_signature ?? '_'}`,
      source: 'healing_quarantine' as const,
      severity: 'critical' as const,
      title: `Voice class quarantined: ${row.class}`,
      description: `Auto-loop stopped on this class. Reason: ${row.reason ?? 'thresholds tripped'}.`,
      evidence: [
        { kind: 'signature', ref: row.normalized_signature ?? '(none)' },
        { kind: 'class', ref: row.class },
      ],
      affected_sessions: null,
      affected_cohort: null,
      likely_owner: 'voice-self-healing',
      source_files: ['services/gateway/src/services/voice-healing-summary.ts'],
      confidence: 0.95,
      recommended_action: 'Investigate quarantined class; release after fix.',
      available_actions: ['investigate', 'open_in_self_healing'],
      source_ref: { table: 'voice_healing_quarantine', id: `${row.class}:${row.normalized_signature ?? '_'}` },
      detected_at: row.quarantined_at,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source 2: voice_architecture_reports (open, non-stay_and_patch)
// ---------------------------------------------------------------------------
async function fetchOpenArchitectureReports(cfg: SupabaseConfig): Promise<ActionItem[]> {
  try {
    const r = await fetch(
      `${cfg.url}/rest/v1/voice_architecture_reports?status=eq.open&select=id,class,normalized_signature,generated_at,report&order=generated_at.desc&limit=50`,
      { headers: authHeaders(cfg) },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{
      id: string;
      class: string;
      normalized_signature: string | null;
      generated_at: string;
      report: any;
    }>;
    const items: ActionItem[] = [];
    for (const row of rows) {
      const rec = row.report?.recommendation ?? {};
      const track = String(rec.track ?? '').toLowerCase();
      if (!track || track === 'stay_and_patch') continue;
      const conf = typeof rec.confidence === 'number' ? rec.confidence : 0.5;
      const summary = String(rec.summary ?? '').slice(0, 220);
      items.push({
        id: `architecture_report:${row.id}`,
        source: 'architecture_report' as const,
        severity: 'warning' as const,
        title: `Architectural recommendation: ${row.class}`,
        description: summary || `Track: ${track}`,
        evidence: [
          { kind: 'track', ref: track },
          { kind: 'class', ref: row.class },
          { kind: 'confidence', ref: `${(conf * 100).toFixed(0)}%` },
        ],
        affected_sessions: null,
        affected_cohort: null,
        likely_owner: 'voice-architecture-investigator',
        source_files: ['services/gateway/src/routes/voice-lab.ts'],
        confidence: conf,
        recommended_action: 'Read the recommendation; accept-and-execute if approved, reject otherwise.',
        available_actions: ['investigate', 'create_vtid', 'reject'],
        source_ref: { table: 'voice_architecture_reports', id: row.id },
        detected_at: row.generated_at,
      });
    }
    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source 3: Awareness watchdogs — failed AND unknown
// ---------------------------------------------------------------------------
async function fetchWatchdogIssues(cfg: SupabaseConfig): Promise<ActionItem[]> {
  void cfg;
  const out: ActionItem[] = [];
  let statuses: WatchdogStatus[] = [];
  try {
    statuses = await getWatchdogStatuses();
  } catch {
    return [];
  }
  // VTID-02899: a watchdog whose every watched signal is wired='not_wired'
  // is by design unable to observe — surfacing it as a blind spot duplicates
  // the awareness_not_wired finding for the same signal. Filter those out so
  // the operator sees one row per gap, not two.
  const manifest = getAwarenessManifest();
  const notWired = new Set<string>();
  for (const sig of manifest) {
    if (sig.wired === 'not_wired') notWired.add(sig.key);
  }
  const allWatchedNotWired = (w: typeof statuses[number]['watchdog']): boolean => {
    if (!w.watches || w.watches.length === 0) return false;
    return w.watches.every((k) => notWired.has(k));
  };

  for (const s of statuses) {
    if (s.verdict === 'fail') {
      out.push({
        id: `watchdog_failed:${s.watchdog.id}`,
        source: 'watchdog_failed' as const,
        severity: 'warning' as const,
        title: `Watchdog failing: ${s.watchdog.name}`,
        description: s.last_result_summary || s.watchdog.description,
        evidence: [
          { kind: 'oasis_topic', ref: s.watchdog.oasis_topic ?? '(none)' },
          ...s.watchdog.watches.map((k) => ({ kind: 'signal', ref: k })),
        ],
        affected_sessions: null,
        affected_cohort: null,
        likely_owner: 'awareness',
        source_files: s.watchdog.source_hint ? [s.watchdog.source_hint] : [],
        confidence: 0.85,
        recommended_action: `Check why the topic ${s.watchdog.oasis_topic} stopped emitting.`,
        available_actions: ['investigate', 'create_vtid'],
        source_ref: { table: 'awareness_watchdogs', id: s.watchdog.id },
        detected_at: new Date().toISOString(),
      });
    } else if (s.verdict === 'unknown') {
      // VTID-02899: suppress if all watched signals are not_wired by design.
      if (allWatchedNotWired(s.watchdog)) continue;
      out.push({
        id: `watchdog_unknown:${s.watchdog.id}`,
        source: 'watchdog_unknown' as const,
        severity: 'info' as const,
        title: `Watchdog blind spot: ${s.watchdog.name}`,
        description: s.last_result_summary || 'No telemetry topic configured — manual probe required.',
        evidence: [...s.watchdog.watches.map((k) => ({ kind: 'signal', ref: k }))],
        affected_sessions: null,
        affected_cohort: null,
        likely_owner: 'awareness',
        source_files: s.watchdog.source_hint ? [s.watchdog.source_hint] : [],
        confidence: 0.7,
        recommended_action: 'Define an oasis_topic for this watchdog or convert to a manual probe.',
        available_actions: ['investigate', 'create_vtid'],
        source_ref: { table: 'awareness_watchdogs', id: s.watchdog.id },
        detected_at: new Date().toISOString(),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source 4: Awareness manifest — wired === 'not_wired'
// ---------------------------------------------------------------------------
function fetchAwarenessNotWired(): ActionItem[] {
  const manifest = getAwarenessManifest();
  const out: ActionItem[] = [];
  for (const sig of manifest) {
    if (sig.wired !== 'not_wired') continue;
    if (sig.enforcement_status === 'pending') continue; // pending = intentional
    out.push({
      id: `awareness_not_wired:${sig.key}`,
      source: 'awareness_not_wired' as const,
      severity: 'info' as const,
      title: `Awareness signal not wired: ${sig.label}`,
      description: sig.description,
      evidence: [
        { kind: 'tier', ref: sig.tier },
        { kind: 'subcategory', ref: sig.subcategory },
        { kind: 'key', ref: sig.key },
      ],
      affected_sessions: null,
      affected_cohort: null,
      likely_owner: 'awareness',
      source_files: ['services/gateway/src/services/awareness-registry.ts'],
      confidence: 0.9,
      recommended_action: `Wire signal ${sig.key} or set enforcement_status='pending'.`,
      available_actions: ['investigate', 'create_vtid'],
      source_ref: { table: 'awareness_manifest', id: sig.key },
      detected_at: new Date().toISOString(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source 5: self_healing_log — escalations + rollbacks (last 24h)
// ---------------------------------------------------------------------------
async function fetchRecentEscalations(cfg: SupabaseConfig): Promise<ActionItem[]> {
  try {
    const since = new Date(Date.now() - ITEM_LOOKBACK_HOURS * 3600_000).toISOString();
    const r = await fetch(
      `${cfg.url}/rest/v1/self_healing_log?outcome=in.(escalated,rolled_back)&created_at=gte.${encodeURIComponent(since)}&select=vtid,endpoint,failure_class,outcome,created_at,diagnosis&order=created_at.desc&limit=50`,
      { headers: authHeaders(cfg) },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{
      vtid: string;
      endpoint: string;
      failure_class: string | null;
      outcome: string;
      created_at: string;
      diagnosis: any;
    }>;
    return rows
      // VTID-02953 (PR-K): drop zombie escalations against retired endpoints
      // and dev_autopilot finding noise — those endpoints aren't actionable
      // from this surface.
      .filter((row) => !isZombieEscalation(row.endpoint, row.failure_class))
      .map((row) => {
        const reason = row.diagnosis?.reason ?? row.diagnosis?.tombstone_reason ?? row.outcome;
        return {
          id: `self_healing_escalation:${row.vtid}`,
          source: 'self_healing_escalation' as const,
          severity: (row.outcome === 'rolled_back' ? 'critical' : 'warning') as ActionSeverity,
          title: `Self-healing ${row.outcome}: ${row.endpoint}`,
          description: `VTID ${row.vtid} (${row.failure_class ?? 'unknown class'}) — ${reason}.`,
          evidence: [
            { kind: 'vtid', ref: row.vtid },
            { kind: 'endpoint', ref: row.endpoint },
            { kind: 'failure_class', ref: row.failure_class ?? '(none)' },
          ],
          affected_sessions: null,
          affected_cohort: null,
          likely_owner: 'self-healing',
          source_files: [],
          confidence: 0.8,
          recommended_action: 'Endpoint requires manual investigation.',
          available_actions: ['investigate', 'open_in_self_healing'],
          source_ref: { table: 'self_healing_log', id: row.vtid },
          detected_at: row.created_at,
        };
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source 5b (VTID-02953 / PR-K): self_healing_log — recent wins (last 24h)
//
// Surfaces autonomous self-heals that reached outcome='fixed' so the cockpit
// reflects what actually worked, not just what's still on fire. Joins
// vtid_ledger to pull the autopilot PR url + merged sha for evidence.
// ---------------------------------------------------------------------------
interface SelfHealWinRow {
  vtid: string;
  endpoint: string;
  failure_class: string | null;
  outcome: string;
  resolved_at: string | null;
  created_at: string;
}

async function fetchRecentSelfHeals(cfg: SupabaseConfig): Promise<ActionItem[]> {
  try {
    const since = new Date(Date.now() - ITEM_LOOKBACK_HOURS * 3600_000).toISOString();
    const r = await fetch(
      `${cfg.url}/rest/v1/self_healing_log?outcome=eq.fixed&created_at=gte.${encodeURIComponent(since)}&select=vtid,endpoint,failure_class,outcome,resolved_at,created_at&order=created_at.desc&limit=50`,
      { headers: authHeaders(cfg) },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as SelfHealWinRow[];
    if (rows.length === 0) return [];
    // Pull PR url + merged sha from vtid_ledger.metadata for evidence.
    const vtidList = rows.map((row) => row.vtid).join(',');
    const ledgerResp = await fetch(
      `${cfg.url}/rest/v1/vtid_ledger?vtid=in.(${vtidList})&select=vtid,metadata`,
      { headers: authHeaders(cfg) },
    );
    const ledgerRows = ledgerResp.ok
      ? ((await ledgerResp.json()) as Array<{ vtid: string; metadata: any }>)
      : [];
    const metaByVtid = new Map<string, any>();
    for (const l of ledgerRows) metaByVtid.set(l.vtid, l.metadata || {});
    return rows.map((row) => {
      const meta = metaByVtid.get(row.vtid) || {};
      const prUrl = (meta.pr_url ?? meta.autopilot_pr_url ?? null) as string | null;
      const prNumber = (meta.pr_number ?? null) as number | null;
      const evidence: ActionItem['evidence'] = [
        { kind: 'vtid', ref: row.vtid },
        { kind: 'endpoint', ref: row.endpoint },
        { kind: 'failure_class', ref: row.failure_class ?? '(none)' },
      ];
      if (prUrl) evidence.push({ kind: 'pr', ref: prUrl });
      const prSuffix = prNumber ? ` (PR #${prNumber})` : '';
      return {
        id: `self_healing_win:${row.vtid}`,
        source: 'self_healing_win' as const,
        severity: 'info' as ActionSeverity,
        title: `Self-healed: ${row.endpoint}${prSuffix}`,
        description: `VTID ${row.vtid} (${row.failure_class ?? 'unknown class'}) — autonomous fix landed${prUrl ? ` via ${prUrl}` : ''}.`,
        evidence,
        affected_sessions: null,
        affected_cohort: null,
        likely_owner: 'self-healing',
        source_files: [],
        confidence: 1.0,
        recommended_action: 'Recently completed — no action needed.',
        available_actions: ['investigate'],
        source_ref: { table: 'self_healing_log', id: row.vtid },
        detected_at: row.resolved_at || row.created_at,
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source 6: autopilot_recommendations (domain='voice', status='new')
// Returns zero rows until PR B updates domainForPath. Degrades gracefully.
// ---------------------------------------------------------------------------
async function fetchAutopilotVoiceFindings(cfg: SupabaseConfig): Promise<ActionItem[]> {
  try {
    const r = await fetch(
      `${cfg.url}/rest/v1/autopilot_recommendations?status=eq.new&domain=eq.voice&select=id,title,summary,risk_class,impact_score,effort_score,created_at,spec_snapshot&order=created_at.desc&limit=50`,
      { headers: authHeaders(cfg) },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{
      id: string;
      title: string;
      summary: string | null;
      risk_class: string | null;
      impact_score: number | null;
      effort_score: number | null;
      created_at: string;
      spec_snapshot: any;
    }>;
    return rows.map((row) => {
      let severity: ActionSeverity = 'info';
      if (row.risk_class === 'high') severity = 'warning';
      else if (row.risk_class === 'critical') severity = 'critical';
      return {
        id: `autopilot_recommendation:${row.id}`,
        source: 'autopilot_recommendation' as const,
        severity,
        title: row.title,
        description: row.summary ?? '',
        evidence: [
          { kind: 'risk_class', ref: row.risk_class ?? 'unknown' },
          { kind: 'impact', ref: row.impact_score?.toString() ?? '0' },
          { kind: 'effort', ref: row.effort_score?.toString() ?? '0' },
        ],
        affected_sessions: null,
        affected_cohort: null,
        likely_owner: row.spec_snapshot?.scanner ?? 'autopilot',
        source_files: row.spec_snapshot?.affected_files ?? [],
        confidence: 0.75,
        recommended_action: row.spec_snapshot?.suggested_action ?? row.summary ?? '',
        available_actions: ['accept_execute', 'snooze', 'reject', 'investigate'],
        source_ref: { table: 'autopilot_recommendations', id: row.id },
        detected_at: row.created_at,
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source 7a: Provider drift — voice_providers enabled but no dispatcher impl.
// (Moved from PR B scanner because requires DB at runtime.)
// ---------------------------------------------------------------------------
async function fetchProviderDrift(cfg: SupabaseConfig): Promise<ActionItem[]> {
  try {
    const r = await fetch(
      `${cfg.url}/rest/v1/voice_providers?enabled=eq.true&select=id,kind,display_name`,
      { headers: authHeaders(cfg) },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{ id: string; kind: string; display_name: string }>;
    const out: ActionItem[] = [];
    for (const row of rows) {
      const set = row.kind === 'tts' ? IMPLEMENTED_TTS_PROVIDERS : row.kind === 'stt' ? IMPLEMENTED_STT_PROVIDERS : null;
      if (!set) continue;
      if (set.has(row.id)) continue;
      out.push({
        id: `provider_drift:${row.kind}:${row.id}`,
        source: 'provider_drift' as const,
        severity: 'warning' as const,
        title: `Provider enabled without dispatcher: ${row.kind} / ${row.id}`,
        description: `${row.display_name || row.id} is marked enabled in voice_providers but no dispatcher implementation exists. PUT to /api/v1/voice/config will refuse to save it.`,
        evidence: [
          { kind: 'provider_kind', ref: row.kind },
          { kind: 'provider_id', ref: row.id },
        ],
        affected_sessions: null,
        affected_cohort: null,
        likely_owner: 'voice-config',
        source_files: ['services/gateway/src/services/voice-config.ts'],
        confidence: 0.95,
        recommended_action: 'Either disable the provider in voice_providers or implement the dispatcher entry.',
        available_actions: ['investigate', 'create_vtid'],
        source_ref: { table: 'voice_providers', id: `${row.kind}:${row.id}` },
        detected_at: new Date().toISOString(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source 7b: failure-classes-without-rule.
// Read DISTINCT class from voice_architecture_reports + cross-check the
// exported taxonomy from voice-failure-taxonomy.ts. Any class with reports
// but no rule → finding.
// ---------------------------------------------------------------------------
async function fetchFailureClassesNoRule(cfg: SupabaseConfig): Promise<ActionItem[]> {
  try {
    // Lazy-import so taxonomy file isn't pulled during testing if not needed.
    // VTID-02899: the export is `VOICE_FAILURE_CLASSES` (array), not
    // `FAILURE_CLASSES` (which doesn't exist). Original lookup never
    // populated knownClasses → every class with an open report was
    // reported as "no rule", producing false-positive findings on classes
    // that already had taxonomy entries (e.g. voice.model_under_responds).
    const taxonomy = await import('./voice-failure-taxonomy').catch(() => null);
    const knownClasses = new Set<string>();
    const arr = taxonomy && (taxonomy as any).VOICE_FAILURE_CLASSES;
    if (Array.isArray(arr)) {
      for (const k of arr) if (typeof k === 'string') knownClasses.add(k);
    }

    const r = await fetch(
      `${cfg.url}/rest/v1/voice_architecture_reports?status=eq.open&select=class&order=generated_at.desc&limit=200`,
      { headers: authHeaders(cfg) },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{ class: string }>;
    const seen = new Set<string>();
    const out: ActionItem[] = [];
    for (const row of rows) {
      if (!row.class || seen.has(row.class)) continue;
      seen.add(row.class);
      if (knownClasses.size > 0 && knownClasses.has(row.class)) continue;
      out.push({
        id: `failure_class_no_rule:${row.class}`,
        source: 'failure_class_no_rule' as const,
        severity: 'warning' as const,
        title: `Failure class without taxonomy rule: ${row.class}`,
        description: `Reports exist for class '${row.class}' but no entry in voice-failure-taxonomy.ts. Self-healing won't dispatch on this class.`,
        evidence: [{ kind: 'class', ref: row.class }],
        affected_sessions: null,
        affected_cohort: null,
        likely_owner: 'voice-self-healing',
        source_files: ['services/gateway/src/services/voice-failure-taxonomy.ts'],
        confidence: 0.85,
        recommended_action: 'Add a rule for this class in voice-failure-taxonomy.ts (bumps SIGNATURE_VERSION).',
        available_actions: ['investigate', 'create_vtid'],
        source_ref: { table: 'voice_failure_taxonomy', id: row.class },
        detected_at: new Date().toISOString(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Voice session health rollup — small derived stats for the header card.
// 24h window from oasis_events.
// ---------------------------------------------------------------------------
async function fetchVoiceSessionHealth(cfg: SupabaseConfig): Promise<VoiceImprovementBriefing['voice_session_health']> {
  const empty = {
    sessions_observed: 0,
    audio_in_zero_count: 0,
    one_way_count: 0,
    audio_in_zero_ratio: 0,
    one_way_ratio: 0,
  };
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const r = await fetch(
      `${cfg.url}/rest/v1/oasis_events?topic=in.(vtid.live.session.stop,voice.live.session.ended)&created_at=gte.${encodeURIComponent(since)}&select=topic,metadata,created_at&order=created_at.desc&limit=500`,
      { headers: authHeaders(cfg) },
    );
    if (!r.ok) return empty;
    const rows = (await r.json()) as Array<{ topic: string; metadata: any; created_at: string }>;
    let total = 0,
      audioInZero = 0,
      oneWay = 0;
    for (const row of rows) {
      total += 1;
      const meta = row.metadata || {};
      const audioIn = Number(meta.audio_in_chunks ?? meta.audio_in ?? 0);
      const audioOut = Number(meta.audio_out_chunks ?? meta.audio_out ?? 0);
      if (audioIn === 0) audioInZero += 1;
      if ((audioIn === 0 && audioOut > 0) || (audioOut === 0 && audioIn > 0)) oneWay += 1;
    }
    if (total === 0) return empty;
    return {
      sessions_observed: total,
      audio_in_zero_count: audioInZero,
      one_way_count: oneWay,
      audio_in_zero_ratio: audioInZero / total,
      one_way_ratio: oneWay / total,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Sort comparator — exported for testing.
// ---------------------------------------------------------------------------
const SEVERITY_ORDER: Record<ActionSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function sortActionItems(items: ActionItem[]): ActionItem[] {
  return [...items].sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const sa = a.affected_sessions ?? 0;
    const sb = b.affected_sessions ?? 0;
    if (sa !== sb) return sb - sa;
    return a.detected_at < b.detected_at ? 1 : -1;
  });
}

// ---------------------------------------------------------------------------
// Dedup — exported for testing.
// Same `id` collapses to one item; later in the array wins (most recent
// fetch source typically). NOT cross-source dedup — that would risk hiding
// related findings; we explicitly want to surface every angle.
// ---------------------------------------------------------------------------
export function dedupeActionItems(items: ActionItem[]): ActionItem[] {
  const map = new Map<string, ActionItem>();
  for (const it of items) map.set(it.id, it);
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// buildVoiceImprovementBriefing — main entry.
// ---------------------------------------------------------------------------
export async function buildVoiceImprovementBriefing(opts?: { max?: number }): Promise<VoiceImprovementBriefing | { error: string }> {
  const t0 = Date.now();
  const cfg = getSupabaseConfig();
  if (!cfg) {
    return { error: 'supabase not configured' };
  }
  const max = opts?.max && opts.max > 0 ? Math.min(opts.max, 100) : MAX_ITEMS_DEFAULT;

  // Fan out — every source is independent.
  const [
    quarantines,
    architectureReports,
    watchdogIssues,
    notWired,
    escalations,
    selfHealWins,
    autopilot,
    providerDrift,
    classesNoRule,
    sessionHealth,
  ] = await Promise.all([
    fetchQuarantines(cfg),
    fetchOpenArchitectureReports(cfg),
    fetchWatchdogIssues(cfg),
    Promise.resolve(fetchAwarenessNotWired()),
    fetchRecentEscalations(cfg),
    fetchRecentSelfHeals(cfg), // VTID-02953 (PR-K): positive surface
    fetchAutopilotVoiceFindings(cfg),
    fetchProviderDrift(cfg),
    fetchFailureClassesNoRule(cfg),
    fetchVoiceSessionHealth(cfg),
  ]);

  const allRaw = [
    ...quarantines,
    ...architectureReports,
    ...watchdogIssues,
    ...notWired,
    ...escalations,
    ...selfHealWins,
    ...autopilot,
    ...providerDrift,
    ...classesNoRule,
  ];
  const deduped = dedupeActionItems(allRaw);
  const sorted = sortActionItems(deduped);
  const capped = sorted.slice(0, max);

  const bySource = capped.reduce((acc, it) => {
    acc[it.source] = (acc[it.source] || 0) + 1;
    return acc;
  }, {} as Record<ActionSource, number>);
  const counts = capped.reduce(
    (a, it) => {
      a[it.severity] += 1;
      return a;
    },
    { critical: 0, warning: 0, info: 0 } as Record<ActionSeverity, number>,
  );

  return {
    generated_at: new Date().toISOString(),
    quality_score: composeQualityScore(capped),
    summary: {
      total_action_items: capped.length,
      critical: counts.critical,
      warning: counts.warning,
      info: counts.info,
      by_source: bySource,
    },
    action_items: capped,
    voice_session_health: sessionHealth,
    generated_in_ms: Date.now() - t0,
  };
}
