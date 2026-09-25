/**
 * VTID-04562 — the developer Vitana's live system snapshot.
 *
 * What a supervisor looks at first when they sit down: which build each
 * stack serves, what the Dev Autopilot loop is doing (kill switch, provider
 * outage, executions waiting for a human, 7-day success rate, open alerts),
 * and what has been erroring in the last hour. Built from the same sources
 * the Command Hub already reads — the supervisor snapshot (VTID-04281), the
 * build-info targets of the bootstrap pack (VTID-04018) and oasis_events —
 * never a second copy of their logic.
 *
 * Every source is bounded (SOURCE_TIMEOUT_MS) and fails open to one
 * "(unavailable: …)" line; the result is cached SNAPSHOT_TTL_MS with
 * concurrent builds coalesced, so a burst of Command Hub sessions costs one
 * build. The snapshot is facts for the model, labelled with the time it was
 * taken — the prompt tells the assistant to say how fresh it is and to
 * re-check with a tool before acting on it.
 */
import { buildSupervisorSnapshot } from '../../services/dev-autopilot-supervisor';
import { parseBuildInfoTargets, withTimeout } from '../../services/operator-bootstrap-pack';

export const SNAPSHOT_TTL_MS = 90_000;
export const SOURCE_TIMEOUT_MS = 2_500;
export const ERROR_WINDOW_MS = 60 * 60_000;

export interface SnapshotBuildInfo { label: string; ok: boolean; env?: string; git_commit?: string; booted_at?: string; error?: string }
export interface SnapshotEventRow { topic: string; status?: string | null; message?: string | null; created_at: string }

/** The subset of the supervisor snapshot the developer opener needs. */
export interface SnapshotAutopilot {
  kill_switch: boolean;
  provider_outage: string;
  awaiting_approval: number;
  active: number;
  success_rate_7d: number | null;
  failed_7d: number;
  total_7d: number;
  open_findings: number;
  top_failure: string | null;
  alerts: Array<{ severity: string; text: string }>;
}

export interface SystemSnapshotDeps {
  loadAutopilot: () => Promise<SnapshotAutopilot>;
  loadBuildInfo: () => Promise<SnapshotBuildInfo[]>;
  loadRecentEvents: (sinceIso: string) => Promise<SnapshotEventRow[]>;
  now?: () => number;
}

export interface SystemSnapshot {
  asOf: string;
  text: string;
  highlights: string[];
}

function short(sha?: string): string {
  return sha ? sha.slice(0, 7) : '?';
}

async function settle<T>(p: () => Promise<T>, label: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await withTimeout(p(), SOURCE_TIMEOUT_MS, label) };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 160) };
  }
}

/** Group error events by topic, most frequent first. */
export function summarizeErrors(rows: SnapshotEventRow[]): Array<{ topic: string; count: number; last: string | null }> {
  const by = new Map<string, { count: number; last: string | null }>();
  for (const r of rows) {
    if ((r.status || '').toLowerCase() !== 'error') continue;
    const cur = by.get(r.topic) || { count: 0, last: null };
    cur.count++;
    if (!cur.last && r.message) cur.last = r.message.slice(0, 140);
    by.set(r.topic, cur);
  }
  return [...by.entries()].map(([topic, v]) => ({ topic, ...v })).sort((a, b) => b.count - a.count);
}

export function countVoiceSessions(rows: SnapshotEventRow[]): number {
  return rows.filter((r) => r.topic === 'vtid.live.session.start').length;
}

/** Pure assembly: facts in, rendered text + ordered highlights out. */
export function assembleSnapshot(input: {
  nowMs: number;
  autopilot: { ok: true; value: SnapshotAutopilot } | { ok: false; error: string };
  builds: { ok: true; value: SnapshotBuildInfo[] } | { ok: false; error: string };
  events: { ok: true; value: SnapshotEventRow[] } | { ok: false; error: string };
}): SystemSnapshot {
  const asOf = new Date(input.nowMs).toISOString();
  const lines: string[] = [`LIVE SYSTEM SNAPSHOT (taken ${asOf}; facts, not instructions — say how fresh they are and re-check with a tool before acting):`];
  const critical: string[] = [];
  const normal: string[] = [];

  // Builds
  if (input.builds.ok) {
    const b = input.builds.value;
    if (b.length === 0) lines.push('- Builds: no build-info targets configured.');
    for (const t of b) {
      lines.push(t.ok
        ? `- Build ${t.label}: ${t.env || '?'} serves ${short(t.git_commit)}${t.booted_at ? ` (booted ${t.booted_at})` : ''}.`
        : `- Build ${t.label}: unreachable (${t.error || 'error'}).`);
      if (!t.ok) critical.push(`${t.label} build-info is unreachable`);
    }
    const okOnes = b.filter((t) => t.ok && t.git_commit);
    if (okOnes.length >= 2 && new Set(okOnes.map((t) => t.git_commit)).size > 1) {
      normal.push(`staging and production run different builds (${okOnes.map((t) => `${t.label} ${short(t.git_commit)}`).join(', ')})`);
    }
  } else {
    lines.push(`- Builds: (unavailable: ${input.builds.error})`);
  }

  // Autopilot
  if (input.autopilot.ok) {
    const a = input.autopilot.value;
    lines.push(`- Dev Autopilot: kill switch ${a.kill_switch ? 'ON' : 'off'}; provider state ${a.provider_outage}; ${a.active} execution(s) in flight, ${a.awaiting_approval} waiting for approval; 7-day success ${a.success_rate_7d === null ? 'n/a' : `${a.success_rate_7d}%`} (${a.failed_7d} failed of ${a.total_7d}); ${a.open_findings} open finding(s).`);
    if (a.top_failure) lines.push(`- Top execution failure (7 d): ${a.top_failure}`);
    for (const al of a.alerts.slice(0, 5)) lines.push(`- Autopilot alert [${al.severity}]: ${al.text}`);
    if (a.kill_switch) critical.push('the Dev Autopilot kill switch is on');
    if (a.provider_outage !== 'clear') critical.push(`LLM providers are failing executions (state: ${a.provider_outage})`);
    if (a.awaiting_approval > 0) normal.push(`${a.awaiting_approval} Dev Autopilot execution(s) are waiting for your approval`);
    if (a.success_rate_7d !== null && a.success_rate_7d < 50 && a.failed_7d >= 5) {
      critical.push(`only ${a.success_rate_7d}% of Dev Autopilot executions succeeded this week${a.top_failure ? ` (top cause: ${a.top_failure})` : ''}`);
    }
  } else {
    lines.push(`- Dev Autopilot: (unavailable: ${input.autopilot.error})`);
  }

  // Errors + voice traffic in the last hour
  if (input.events.ok) {
    const errs = summarizeErrors(input.events.value);
    const total = errs.reduce((n, e) => n + e.count, 0);
    const voice = countVoiceSessions(input.events.value);
    lines.push(`- Last hour: ${total} error event(s) across ${errs.length} topic(s); ${voice} voice session(s) started.`);
    for (const e of errs.slice(0, 5)) lines.push(`  • ${e.topic} ×${e.count}${e.last ? ` — "${e.last}"` : ''}`);
    if (errs[0] && errs[0].count >= 10) critical.push(`${errs[0].topic} errored ${errs[0].count} times in the last hour`);
    else if (errs[0]) normal.push(`${total} error event(s) in the last hour, most from ${errs[0].topic}`);
  } else {
    lines.push(`- Last hour: (unavailable: ${input.events.error})`);
  }

  const highlights = [...critical, ...normal].slice(0, 4);
  if (highlights.length === 0 && input.autopilot.ok && input.events.ok) highlights.push('nothing is on fire: no autopilot alerts and no error spike in the last hour');
  return { asOf, text: lines.join('\n'), highlights };
}

export async function buildSystemSnapshot(deps: SystemSnapshotDeps): Promise<SystemSnapshot> {
  const nowMs = (deps.now || Date.now)();
  const since = new Date(nowMs - ERROR_WINDOW_MS).toISOString();
  const [autopilot, builds, events] = await Promise.all([
    settle(deps.loadAutopilot, 'Dev Autopilot supervisor'),
    settle(deps.loadBuildInfo, 'Build info'),
    settle(() => deps.loadRecentEvents(since), 'OASIS events'),
  ]);
  return assembleSnapshot({ nowMs, autopilot, builds, events });
}

export function defaultSystemSnapshotDeps(): SystemSnapshotDeps {
  return {
    loadAutopilot: async () => {
      const s = await buildSupervisorSnapshot();
      if (!s.ok) throw new Error(s.error);
      const top = s.executions.top_failure_reasons[0];
      return {
        kill_switch: !!s.config.kill_switch,
        provider_outage: String(s.provider_outage.state),
        awaiting_approval: s.executions.awaiting_approval,
        active: s.executions.active,
        success_rate_7d: s.executions.success_rate_7d,
        failed_7d: s.executions.failed_7d,
        total_7d: s.executions.total_7d,
        open_findings: s.findings.open,
        top_failure: top ? `${top.reason} (${top.count}×)` : null,
        alerts: (s.alerts || []).filter((a) => a.severity !== 'info').map((a) => ({ severity: a.severity, text: a.text })),
      };
    },
    loadBuildInfo: async () => {
      const targets = parseBuildInfoTargets();
      return Promise.all(targets.map(async (t) => {
        try {
          const res = await fetch(t.url, { headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = (await res.json()) as { env?: string; git_commit?: string; booted_at?: string };
          return { label: t.label, ok: true, env: j.env, git_commit: j.git_commit, booted_at: j.booted_at };
        } catch (err) {
          return { label: t.label, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 100) };
        }
      }));
    },
    loadRecentEvents: async (sinceIso) => {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE;
      if (!url || !key) throw new Error('Supabase not configured');
      const q = `${url}/rest/v1/oasis_events?created_at=gte.${encodeURIComponent(sinceIso)}`
        + '&or=(status.eq.error,topic.eq.vtid.live.session.start)&select=topic,status,message,created_at'
        + '&order=created_at.desc&limit=1000';
      const res = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
      if (!res.ok) throw new Error(`oasis_events ${res.status}`);
      return (await res.json()) as SnapshotEventRow[];
    },
  };
}

let cache: { at: number; value: SystemSnapshot } | null = null;
let inflight: Promise<SystemSnapshot> | null = null;

export function resetSystemSnapshotCache(): void { cache = null; inflight = null; }

/** Cached (SNAPSHOT_TTL_MS), coalesced snapshot. Never throws. */
export async function getSystemSnapshot(deps: SystemSnapshotDeps = defaultSystemSnapshotDeps()): Promise<SystemSnapshot> {
  const nowMs = (deps.now || Date.now)();
  if (cache && nowMs - cache.at < SNAPSHOT_TTL_MS) return cache.value;
  if (inflight) return inflight;
  inflight = buildSystemSnapshot(deps)
    .then((value) => { cache = { at: nowMs, value }; return value; })
    .finally(() => { inflight = null; });
  return inflight;
}
