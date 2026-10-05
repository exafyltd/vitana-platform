/**
 * VTID-04876 — Command Hub Overview Phase 1: the /ops/attention aggregator.
 *
 * Runs the seven adapters (services/ops-attention-adapters.ts) in parallel,
 * each bounded by its own budget (AdapterSpec.timeoutMs, else ADAPTER_TIMEOUT_MS,
 * 3 s; service health 8 s, autonomy 6 s); a source that throws or times out
 * is UNKNOWN. Candidates become ranked items with env-scoped fingerprints and
 * time-based hysteresis:
 *
 *   - A candidate with a source timestamp (`since`) is stateless: it opens
 *     once `now - since >= hold_ms` (identical across tasks, plan N2).
 *   - A candidate without one uses `ops_attention_state` (env, fingerprint,
 *     first_seen, last_seen): first_seen is kept while the fingerprint keeps
 *     being observed, and reset when it was not seen for CLEAR_GRACE_MS
 *     (3 poll intervals) — so a flapping check does not restart its clock,
 *     and a cleared one does.
 *   - A state read or write failure never breaks the response: it is logged,
 *     the request falls back to "first seen at this request", and the
 *     `attention_state` source reports it (read failure = UNKNOWN, because a
 *     2-minute hold can then never open and that must not look green).
 *
 * Verdict: CRITICAL when any P1 item is shown; else UNKNOWN when any source
 * is unknown (never green on missing data); else ATTENTION when P2/P3 items
 * are shown; else OK.
 *
 * Computed on demand only while a viewer has the Overview open (plan F2): no
 * background loop. One computation per task at a time (single-flight) and a
 * CACHE_MS (25 s) cache. The env comes from VITANA_ENV (env.ts); staging
 * writes env='staging' state rows (owner decision 6, 2026-10-04) and the
 * status bar labels it "Staging build · production data".
 *
 * VTID-04885 (Phase 2): six more adapters and `domains`, one summary per plan
 * domain (buildDomainSummary).
 *
 * VTID-04886 (Phase 3):
 *   - Ack / Snooze (ops_attention_acks, plan F5). The latest unexpired row per
 *     fingerprint wins. An acked item stays in the queue, marked `ack` (the
 *     UI de-emphasises it). A snoozed item is moved to `hidden` until its
 *     expiry and `counts.hidden` says how many — never silently dropped. A P1
 *     is never hidden: a snoozed fingerprint that reaches P1 is shown again,
 *     marked `snooze_overridden`. An ack read failure hides nothing (every
 *     item is shown) and is reported in `acks_error`.
 *   - A 24 h change & incident timeline from the deploy / verify / rollback /
 *     kill-switch / control topics and self_healing_log, and two hourly
 *     sparklines derived from it (deploys, incidents). Its own 3 s budget; a
 *     failure gives `timeline.error` and `sparklines: null`, never an empty
 *     "quiet day".
 *   - recordOpsAttentionAction(): the write side behind POST /ack and /snooze.
 */

import { VITANA_ENV, type VitanaEnv } from '../env';
import {
  ATTENTION_ADAPTERS,
  NOT_WIRED_SOURCES,
  SELF_HEAL_ENDPOINT_BLOCKLIST,
  TILE_DOMAINS,
  TIMELINE_READ_LIMIT,
  type OasisEventRow,
  type SelfHealRow,
  type AdapterSpec,
  type TileDomainKey,
  type AttentionReads,
  type AttentionSourceId,
  type Candidate,
  type Deeplink,
  type Severity,
} from './ops-attention-adapters';

export const ADAPTER_TIMEOUT_MS = 3_000;
export const CACHE_MS = 25_000;
export const CLEAR_GRACE_MS = 90_000;
export const MAX_ITEMS = 100;

export type Verdict = 'CRITICAL' | 'UNKNOWN' | 'ATTENTION' | 'OK';

export interface AttentionSource {
  id: AttentionSourceId | 'attention_state';
  status: 'ok' | 'unknown';
  fetched_at: string;
  error?: string;
}

export interface AttentionItem {
  id: string;
  fingerprint: string;
  domain: Candidate['domain'];
  severity: Severity;
  title: string;
  detail: string;
  since: string;
  count: number;
  source: AttentionSourceId;
  deeplink: Deeplink;
  evidence: Record<string, unknown>;
  /** VTID-04886: the active ack (or the snooze a P1 overrode). */
  ack?: AckMark;
  /** VTID-04886: snoozed, but it is P1 now, so it is shown. */
  snooze_overridden?: boolean;
}

// ── VTID-04886: Ack / Snooze ────────────────────────────────────────────────

export type AckAction = 'ack' | 'snooze';
/** Plan F5: an ack or snooze expires within 24 h. */
export const ACK_MAX_MINUTES = 24 * 60;
export const ACK_READ_TIMEOUT_MS = 3_000;
export const TIMELINE_TIMEOUT_MS = 3_000;
export const TIMELINE_WINDOW_MS = 24 * 60 * 60_000;
export const TIMELINE_MAX_EVENTS = 50;

export interface AckRow {
  id: string;
  env: VitanaEnv;
  fingerprint: string;
  action: AckAction;
  reason: string;
  severity: Severity | null;
  actor_user_id: string | null;
  actor_email: string | null;
  vtid: string | null;
  created_at: string;
  expires_at: string;
}

export interface AckMark {
  action: AckAction;
  reason: string;
  actor_email: string | null;
  vtid: string | null;
  created_at: string;
  expires_at: string;
}

export interface HiddenItem {
  id: string;
  fingerprint: string;
  severity: Severity;
  domain: Candidate['domain'];
  source: AttentionSourceId;
  title: string;
  snoozed_until: string;
  reason: string;
  actor_email: string | null;
}

/** ops_attention_acks access (service role). */
export interface AttentionAckStore {
  /** Rows of `env` whose expires_at is after `nowIso`. */
  active(env: VitanaEnv, nowIso: string): Promise<AckRow[]>;
  insert(row: Omit<AckRow, 'id'>): Promise<AckRow>;
}

// ── VTID-04886: timeline + sparklines ───────────────────────────────────────

export interface TimelineEvent {
  at: string;
  kind: 'deploy' | 'verify' | 'rollback' | 'self_heal' | 'kill_switch' | 'control';
  tone: 'good' | 'bad' | 'info';
  title: string;
  topic: string;
}

export interface Timeline {
  window_hours: number;
  events: TimelineEvent[];
  truncated: boolean;
  error: string | null;
}

export interface Sparklines {
  window_hours: number;
  bucket_minutes: number;
  series: Array<{ key: 'deploys' | 'incidents'; label: string; buckets: number[]; total: number }>;
}

/**
 * VTID-04885: one tile per plan domain, computed from the same sources and
 * items as the queue. A domain with no adapter is `not_monitored` — never
 * unknown and never OK.
 */
export interface DomainSummary {
  key: TileDomainKey;
  label: string;
  monitored: boolean;
  status: 'ok' | 'unknown' | 'not_monitored';
  worst_severity: Severity | null;
  open: number;
  sources_fresh: number;
  sources_total: number;
  /** The oldest fetch among the domain's sources (its freshness), or null. */
  fetched_at: string | null;
  /** VTID-04886: snoozed items of this domain (not in `open`). */
  hidden: number;
  source_ids: string[];
  errors: string[];
  not_wired: Array<{ id: string; reason: string }>;
  deeplink: Deeplink;
}

export interface AttentionData {
  generated_at: string;
  env: VitanaEnv;
  verdict: Verdict;
  /** p1/p2/p3 count the items shown; `acked` of those are acked; `hidden` are snoozed (VTID-04886). */
  counts: { p1: number; p2: number; p3: number; acked: number; hidden: number };
  sources: AttentionSource[];
  items: AttentionItem[];
  domains: DomainSummary[];
  /** VTID-04886: snoozed items, hidden from the queue until expiry. */
  hidden: HiddenItem[];
  /** VTID-04886: why acks could not be read (then nothing is hidden). */
  acks_error: string | null;
  timeline: Timeline;
  /** null when the timeline could not be read (never a flat "quiet" line). */
  sparklines: Sparklines | null;
}

export interface StateRow {
  fingerprint: string;
  first_seen: string;
  last_seen: string;
}

/** ops_attention_state access (service role). */
export interface AttentionStateStore {
  load(env: VitanaEnv, fingerprints: string[]): Promise<StateRow[]>;
  save(env: VitanaEnv, rows: StateRow[]): Promise<void>;
}

export interface BuildAttentionInput {
  env: VitanaEnv;
  now: number;
  reads: AttentionReads;
  state: AttentionStateStore;
  /** VTID-04886: ops_attention_acks; omitted = nothing acked or snoozed. */
  acks?: AttentionAckStore;
  adapters?: AdapterSpec[];
  adapterTimeoutMs?: number;
}

export function fingerprintOf(env: VitanaEnv, source: string, key: string): string {
  return `${env}:${source}:${key}`;
}

const SEVERITY_RANK: Record<Severity, number> = { P1: 0, P2: 1, P3: 2 };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export function computeVerdict(counts: Pick<AttentionData['counts'], 'p1' | 'p2' | 'p3'>, sources: AttentionSource[]): Verdict {
  if (counts.p1 > 0) return 'CRITICAL';
  if (sources.some((s) => s.status === 'unknown')) return 'UNKNOWN';
  if (counts.p2 + counts.p3 > 0) return 'ATTENTION';
  return 'OK';
}

const SEVERITIES: Severity[] = ['P1', 'P2', 'P3'];

/** VTID-04885: the 13 domain tiles from the sources and the (unsliced) items. */
export function buildDomainSummary(sources: AttentionSource[], items: AttentionItem[], hidden: HiddenItem[] = []): DomainSummary[] {
  return TILE_DOMAINS.map((d) => {
    const own = sources.filter((s) => (d.sources as string[]).includes(s.id));
    const notWired = NOT_WIRED_SOURCES.filter((n) => n.domain === d.key).map((n) => ({ id: n.id, reason: n.reason }));
    const its = items.filter((i) => (d.sources as string[]).includes(i.source));
    const monitored = d.sources.length > 0;
    // A monitored domain whose adapter did not run at all (not in `sources`)
    // is unknown, exactly like one whose adapter failed.
    const missing = monitored && own.length < d.sources.length;
    const unknown = missing || own.some((s) => s.status !== 'ok');
    const fetched = own.map((s) => s.fetched_at).sort();
    return {
      key: d.key,
      label: d.label,
      monitored,
      status: !monitored ? 'not_monitored' : unknown ? 'unknown' : 'ok',
      worst_severity: SEVERITIES.find((sev) => its.some((i) => i.severity === sev)) ?? null,
      open: its.length,
      sources_fresh: own.filter((s) => s.status === 'ok').length,
      sources_total: d.sources.length,
      fetched_at: fetched[0] ?? null,
      hidden: hidden.filter((h) => (d.sources as string[]).includes(h.source)).length,
      source_ids: [...d.sources],
      errors: own.filter((s) => s.error).map((s) => `${s.id}: ${s.error}`),
      not_wired: notWired,
      deeplink: d.deeplink,
    };
  });
}

/**
 * VTID-04886: the latest unexpired row per fingerprint decides. `ack` marks
 * the item; `snooze` hides it — unless the item is P1 now (P1 is never
 * hidden; it is shown, marked snooze_overridden).
 */
export function applyAcks(items: AttentionItem[], rows: AckRow[], now: number): { shown: AttentionItem[]; hidden: HiddenItem[] } {
  const latest = new Map<string, AckRow>();
  for (const r of rows) {
    if (Date.parse(r.expires_at) <= now) continue;
    const prev = latest.get(r.fingerprint);
    if (!prev || Date.parse(r.created_at) > Date.parse(prev.created_at)) latest.set(r.fingerprint, r);
  }
  const shown: AttentionItem[] = [];
  const hidden: HiddenItem[] = [];
  for (const item of items) {
    const r = latest.get(item.fingerprint);
    if (!r) {
      shown.push(item);
      continue;
    }
    const mark: AckMark = { action: r.action, reason: r.reason, actor_email: r.actor_email, vtid: r.vtid, created_at: r.created_at, expires_at: r.expires_at };
    if (r.action === 'snooze' && item.severity !== 'P1') {
      hidden.push({
        id: item.id, fingerprint: item.fingerprint, severity: item.severity, domain: item.domain, source: item.source,
        title: item.title, snoozed_until: r.expires_at, reason: r.reason, actor_email: r.actor_email,
      });
      continue;
    }
    shown.push({ ...item, ack: mark, ...(r.action === 'snooze' ? { snooze_overridden: true } : {}) });
  }
  return { shown, hidden };
}

const TIMELINE_CLASS: Record<string, Pick<TimelineEvent, 'kind' | 'tone' | 'title'>> = {
  'prod.deploy.completed': { kind: 'deploy', tone: 'good', title: 'Production deploy completed' },
  'prod.deploy.failed': { kind: 'deploy', tone: 'bad', title: 'Production deploy failed' },
  'prod.deploy.rolled_back': { kind: 'rollback', tone: 'bad', title: 'Production deploy rolled back' },
  'staging.deploy.completed': { kind: 'deploy', tone: 'info', title: 'Staging deploy completed' },
  'staging.deploy.failed': { kind: 'deploy', tone: 'bad', title: 'Staging deploy failed' },
  'staging.verify.passed': { kind: 'verify', tone: 'good', title: 'STAGING-VERIFY passed' },
  'staging.verify.failed': { kind: 'verify', tone: 'bad', title: 'STAGING-VERIFY failed' },
  'deploy.gateway.failed': { kind: 'deploy', tone: 'bad', title: 'Gateway deploy failed' },
  'cicd.deploy.service.failed': { kind: 'deploy', tone: 'bad', title: 'Service deploy failed' },
  'dev_autopilot.kill_switch.activated': { kind: 'kill_switch', tone: 'bad', title: 'Dev Autopilot kill switch engaged' },
  'dev_autopilot.kill_switch.deactivated': { kind: 'kill_switch', tone: 'good', title: 'Dev Autopilot kill switch released' },
  'governance.control.updated': { kind: 'control', tone: 'info', title: 'Governance control changed' },
};

function eventDetail(ev: OasisEventRow): string {
  const m = (ev.metadata || {}) as Record<string, unknown>;
  const bits = [m.service, m.commit ? String(m.commit).slice(0, 7) : null, m.key, m.control_key].filter((x) => typeof x === 'string' && x);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

/** Pure: timeline events (newest first) from OASIS rows and self-heal rows. */
export function timelineFrom(events: OasisEventRow[], heals: SelfHealRow[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const ev of events) {
    const c = TIMELINE_CLASS[ev.topic];
    if (!c) continue;
    out.push({ at: ev.created_at, kind: c.kind, tone: c.tone, title: c.title + eventDetail(ev), topic: ev.topic });
  }
  for (const h of heals) {
    if (SELF_HEAL_ENDPOINT_BLOCKLIST.some((p) => (h.endpoint || '').startsWith(p))) continue;
    out.push({ at: h.created_at, kind: 'self_heal', tone: 'bad', title: `Self-healing ${h.outcome.replace('_', ' ')}: ${h.endpoint}`, topic: `self_healing.${h.outcome}` });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Pure: hourly buckets (oldest first) over the window ending at `now`. */
export function sparklinesFrom(events: TimelineEvent[], now: number): Sparklines {
  const hours = TIMELINE_WINDOW_MS / 3_600_000;
  const bucket = (pred: (e: TimelineEvent) => boolean) => {
    const b = new Array(hours).fill(0) as number[];
    for (const e of events) {
      if (!pred(e)) continue;
      const idx = hours - 1 - Math.floor((now - Date.parse(e.at)) / 3_600_000);
      if (idx >= 0 && idx < hours) b[idx]++;
    }
    return b;
  };
  const deploys = bucket((e) => e.kind === 'deploy' && e.tone !== 'bad');
  const incidents = bucket((e) => e.tone === 'bad');
  const sum = (b: number[]) => b.reduce((n, x) => n + x, 0);
  return {
    window_hours: hours,
    bucket_minutes: 60,
    series: [
      { key: 'deploys', label: 'Deploys / h', buckets: deploys, total: sum(deploys) },
      { key: 'incidents', label: 'Incidents / h', buckets: incidents, total: sum(incidents) },
    ],
  };
}

/** The timeline and sparklines; a read failure or timeout is reported, never an empty day. */
export async function buildTimeline(reads: AttentionReads, now: number): Promise<{ timeline: Timeline; sparklines: Sparklines | null }> {
  const since = new Date(now - TIMELINE_WINDOW_MS).toISOString();
  try {
    const [events, heals] = await withTimeout(
      Promise.all([reads.timelineEvents(since), reads.selfHealOutcomes(since)]),
      TIMELINE_TIMEOUT_MS,
    );
    const all = timelineFrom(events, heals);
    return {
      timeline: { window_hours: 24, events: all.slice(0, TIMELINE_MAX_EVENTS), truncated: events.length >= TIMELINE_READ_LIMIT || all.length > TIMELINE_MAX_EVENTS, error: null },
      sparklines: sparklinesFrom(all, now),
    };
  } catch (err) {
    return { timeline: { window_hours: 24, events: [], truncated: false, error: errMessage(err) }, sparklines: null };
  }
}

/** One full computation, uncached. Never throws for an adapter or state failure. */
export async function buildOpsAttention(input: BuildAttentionInput): Promise<AttentionData> {
  const { env, now, reads, state } = input;
  const adapters = input.adapters ?? ATTENTION_ADAPTERS;
  const nowIso = new Date(now).toISOString();

  // VTID-04886: the timeline and the active acks are read alongside the
  // adapters, each with its own budget; neither can fail the response.
  const timelineP = buildTimeline(reads, now);
  const acksP: Promise<{ rows: AckRow[]; error: string | null }> = input.acks
    ? withTimeout(input.acks.active(env, nowIso), ACK_READ_TIMEOUT_MS)
        .then((rows) => ({ rows, error: null }))
        .catch((err) => {
          console.error('[ops-attention] ack read failed — nothing is hidden:', errMessage(err));
          return { rows: [] as AckRow[], error: errMessage(err) };
        })
    : Promise.resolve({ rows: [] as AckRow[], error: null });

  const runs = await Promise.all(
    adapters.map(async (a) => {
      try {
        const out = await withTimeout(a.run(reads, { now }), input.adapterTimeoutMs ?? a.timeoutMs ?? ADAPTER_TIMEOUT_MS);
        return { id: a.id, out, error: out.partial_error, fetched_at: new Date().toISOString() };
      } catch (err) {
        return { id: a.id, out: null, error: errMessage(err), fetched_at: new Date().toISOString() };
      }
    }),
  );

  const sources: AttentionSource[] = runs.map((r) => ({
    id: r.id,
    status: r.error ? 'unknown' : 'ok',
    fetched_at: r.fetched_at,
    ...(r.error ? { error: r.error } : {}),
  }));

  // Fingerprint every candidate; the ones without a source timestamp need state.
  const all = runs.flatMap((r) =>
    (r.out?.candidates ?? []).map((c) => ({ source: r.id, c, fingerprint: fingerprintOf(env, r.id, c.key) })),
  );
  const stateful = all.filter((x) => !x.c.since);

  const stateSource: AttentionSource = { id: 'attention_state', status: 'ok', fetched_at: nowIso };
  const prior = new Map<string, StateRow>();
  if (stateful.length) {
    try {
      for (const row of await state.load(env, stateful.map((x) => x.fingerprint))) prior.set(row.fingerprint, row);
    } catch (err) {
      console.error('[ops-attention] state read failed — falling back to first seen at this request:', errMessage(err));
      stateSource.status = 'unknown';
      stateSource.error = `state_read_failed: ${errMessage(err)}`;
    }
  }

  const firstSeen = new Map<string, string>();
  const writes: StateRow[] = [];
  for (const x of stateful) {
    const p = prior.get(x.fingerprint);
    const keep = p && now - Date.parse(p.last_seen) <= CLEAR_GRACE_MS;
    const fs = keep ? p!.first_seen : nowIso;
    firstSeen.set(x.fingerprint, fs);
    writes.push({ fingerprint: x.fingerprint, first_seen: fs, last_seen: nowIso });
  }
  if (writes.length && stateSource.status === 'ok') {
    try {
      await state.save(env, writes);
    } catch (err) {
      console.error('[ops-attention] state write failed (response unaffected):', errMessage(err));
      stateSource.error = `state_write_failed: ${errMessage(err)}`;
    }
  }
  sources.push(stateSource);

  const items: AttentionItem[] = [];
  for (const x of all) {
    const since = x.c.since ?? firstSeen.get(x.fingerprint) ?? nowIso;
    if (now - Date.parse(since) < x.c.hold_ms) continue; // not held long enough yet
    items.push({
      id: `${x.source}:${x.c.key}`,
      fingerprint: x.fingerprint,
      domain: x.c.domain,
      severity: x.c.severity,
      title: x.c.title,
      detail: x.c.detail,
      since,
      count: x.c.count,
      source: x.source,
      deeplink: x.c.deeplink,
      evidence: x.c.evidence,
    });
  }

  // VTID-04886: acks and snoozes.
  const acks = await acksP;
  const { shown, hidden } = applyAcks(items, acks.rows, now);

  // Rank: severity, then the longest-standing first.
  shown.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || Date.parse(a.since) - Date.parse(b.since));
  const counts = {
    p1: shown.filter((i) => i.severity === 'P1').length,
    p2: shown.filter((i) => i.severity === 'P2').length,
    p3: shown.filter((i) => i.severity === 'P3').length,
    acked: shown.filter((i) => i.ack && i.ack.action === 'ack').length,
    hidden: hidden.length,
  };
  const { timeline, sparklines } = await timelineP;
  return {
    generated_at: nowIso,
    env,
    verdict: computeVerdict(counts, sources),
    counts,
    sources,
    items: shown.slice(0, MAX_ITEMS),
    domains: buildDomainSummary(sources, shown, hidden),
    hidden,
    acks_error: acks.error,
    timeline,
    sparklines,
  };
}

// ── Cached, single-flight entry point used by the route ─────────────────────

let cache: { at: number; value: AttentionData } | null = null;
let inFlight: Promise<AttentionData> | null = null;
interface DepsOverride {
  reads?: () => AttentionReads;
  state?: () => AttentionStateStore;
  /** VTID-04886 */
  acks?: () => AttentionAckStore;
  emit?: (event: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
}
let depsOverride: DepsOverride | null = null;

export function resetOpsAttentionCacheForTests(): void {
  cache = null;
  inFlight = null;
}

/** VTID-04886: an ack/snooze must show on the next read, not after the 25 s cache. */
export function invalidateOpsAttentionCache(): void {
  cache = null;
}

/** Tests inject fake reads/state/acks/emit; production uses ops-attention-reads.ts. */
export function setOpsAttentionDepsForTests(deps: DepsOverride | null): void {
  depsOverride = deps;
  resetOpsAttentionCacheForTests();
}

function prodDeps(): any {
  // Lazy require keeps this module's import graph light for unit tests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./ops-attention-reads');
}

function ackStore(): AttentionAckStore {
  return depsOverride?.acks ? depsOverride.acks() : prodDeps().supabaseAckStore();
}

export interface GetOpsAttentionOptions {
  /** The admin caller's Authorization header, forwarded to the health probes. */
  authHeader?: string;
  now?: number;
}

export async function getOpsAttention(opts: GetOpsAttentionOptions = {}): Promise<{ data: AttentionData; cached: boolean }> {
  const now = opts.now ?? Date.now();
  if (cache && now - cache.at < CACHE_MS) return { data: cache.value, cached: true };
  if (!inFlight) {
    // Lazy require keeps this module's import graph light for unit tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const prod = depsOverride?.reads && depsOverride?.state ? null : require('./ops-attention-reads');
    const reads: AttentionReads = depsOverride?.reads
      ? depsOverride.reads()
      : prod.createAttentionReads({ authHeader: opts.authHeader });
    const state: AttentionStateStore = depsOverride?.state ? depsOverride.state() : prod.supabaseAttentionStateStore();
    // Tests that inject reads without acks get no ack store (nothing hidden).
    const acks: AttentionAckStore | undefined = depsOverride?.reads && !depsOverride.acks ? undefined : ackStore();
    inFlight = buildOpsAttention({ env: VITANA_ENV, now, reads, state, acks })
      .then((value) => {
        cache = { at: now, value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return { data: await inFlight, cached: false };
}

// ── VTID-04886: the write side of POST /ack and POST /snooze ────────────────

export interface RecordActionInput {
  action: AckAction;
  fingerprint: string;
  reason: string;
  durationMinutes: number;
  vtid: string | null;
  actor: { user_id: string | null; email: string | null };
  authHeader?: string;
  now?: number;
}

export type RecordActionResult =
  | { ok: true; data: { id: string; action: AckAction; fingerprint: string; severity: Severity; expires_at: string; oasis_emitted: boolean } }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Validates against the CURRENT computation (the item must be open now in
 * this env; its severity is the server's, never the client's), writes
 * ops_attention_acks, emits ops.attention.acked / ops.attention.snoozed and
 * invalidates the cache. P1 is never snoozable. The route has already
 * checked the body shape (Zod) and the caller (requireAdminAuth).
 */
export async function recordOpsAttentionAction(input: RecordActionInput): Promise<RecordActionResult> {
  if (input.durationMinutes < 1 || input.durationMinutes > ACK_MAX_MINUTES) {
    return { ok: false, status: 400, error: 'expiry_over_24h' };
  }
  if (!input.fingerprint.startsWith(`${VITANA_ENV}:`)) return { ok: false, status: 400, error: 'wrong_env' };
  const { data } = await getOpsAttention({ authHeader: input.authHeader });
  const item = data.items.find((i) => i.fingerprint === input.fingerprint) || data.hidden.find((h) => h.fingerprint === input.fingerprint);
  if (!item) return { ok: false, status: 404, error: 'not_open' };
  if (input.action === 'snooze' && item.severity === 'P1') return { ok: false, status: 400, error: 'p1_not_snoozable' };

  const now = input.now ?? Date.now();
  const row = await ackStore().insert({
    env: VITANA_ENV,
    fingerprint: input.fingerprint,
    action: input.action,
    reason: input.reason,
    severity: item.severity,
    actor_user_id: input.actor.user_id,
    actor_email: input.actor.email,
    vtid: input.vtid,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + input.durationMinutes * 60_000).toISOString(),
  });

  const event = {
    vtid: input.vtid || 'VTID-04886',
    type: input.action === 'ack' ? 'ops.attention.acked' : 'ops.attention.snoozed',
    source: 'command-hub:ops-attention',
    status: 'info',
    message: `${input.action === 'ack' ? 'Acked' : 'Snoozed'} ${item.severity} "${item.title}" until ${row.expires_at}: ${input.reason}`,
    payload: {
      ack_id: row.id,
      env: VITANA_ENV,
      fingerprint: input.fingerprint,
      action: input.action,
      severity: item.severity,
      title: item.title,
      reason: input.reason,
      expires_at: row.expires_at,
      linked_vtid: input.vtid,
    },
    actor_id: input.actor.user_id ?? undefined,
    actor_email: input.actor.email ?? undefined,
    actor_role: 'admin',
    surface: 'command-hub',
  };
  let oasisEmitted = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const emit = depsOverride?.emit ?? require('./oasis-event-service').emitOasisEvent;
    const r = await emit(event);
    oasisEmitted = !!(r && r.ok);
    if (!oasisEmitted) console.error(`[ops-attention] OASIS ${event.type} not recorded:`, r && r.error);
  } catch (err) {
    console.error(`[ops-attention] OASIS ${event.type} failed:`, errMessage(err));
  }
  invalidateOpsAttentionCache();
  return {
    ok: true,
    data: { id: row.id, action: input.action, fingerprint: input.fingerprint, severity: item.severity, expires_at: row.expires_at, oasis_emitted: oasisEmitted },
  };
}
