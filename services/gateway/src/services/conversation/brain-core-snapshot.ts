/**
 * VTID-04399 (Plan v1 WS-1.2) — pre-computed core context snapshot per user.
 *
 * WHY: the voice session's context build (`buildBrainSystemInstruction`,
 * memory + calendar + OASIS + Life Compass + identity + proactive guide) takes
 * seconds, and the stream-open gate in orb-live.ts only waits
 * `ORB_CONTEXT_READY_GATE_TIMEOUT_MS` (300 ms on both stacks) for it. Measured
 * over 7 days of `voice.latency.measured` turn-0 rows joined to
 * `vtid.live.session.start`: almost every authenticated session timed out on
 * that wait, and 53 of 158 set up the model with ZERO context characters —
 * the whole conversation ran without the user's memory, name or goal,
 * because nothing puts the late context into a session that is already
 * connected (only a later transparent reconnect rebuilds it).
 *
 * WHAT: after every fresh build the stable part of the instruction (everything
 * before the time-bound proactive guide block — identity, memory, Life
 * Compass goal, general rules) is stored as one `user_assistant_state` row. At
 * session start that row is read in parallel with the fresh build (one indexed
 * read). When the fresh build misses the gate, the gate uses the snapshot
 * instead of an empty context. The fresh build still overwrites
 * `session.contextInstruction` when it lands, exactly as before.
 *
 * Refresh points: every fresh build (write-through, throttled) and the end of
 * every session with a user turn (a delayed rebuild, so facts the session's
 * memory commit extracted are in the next session's snapshot).
 *
 * Scope: community role only. One row per user; a Command Hub (developer /
 * admin) build must never overwrite the community snapshot, and those
 * surfaces are low volume.
 *
 * Kill switch: `BRAIN_CORE_SNAPSHOT=false` disables read, write and refresh.
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export const BRAIN_CORE_SNAPSHOT_SIGNAL = 'brain_core_snapshot_v1';
export const BRAIN_CORE_SNAPSHOT_VERSION = 1;
/** Hard bound on the stored text; the instruction packer bounds it again. */
export const BRAIN_CORE_SNAPSHOT_MAX_CHARS = 32_000;
const DEFAULT_MAX_AGE_MS = 72 * 3_600_000;
const DEFAULT_MIN_WRITE_INTERVAL_MS = 10 * 60_000;
const DEFAULT_STALE_REWRITE_MS = 6 * 3_600_000;
const DEFAULT_READ_TIMEOUT_MS = 1_500;
const DEFAULT_REFRESH_DELAY_MS = 90_000;

export type SnapshotRole = 'community';

export interface BrainCoreSnapshot {
  version: number;
  role: SnapshotRole;
  lang: string | null;
  built_at: string;
  chars: number;
  hash: string;
  source: 'session_build' | 'finalize_refresh';
  instruction: string;
}

export function isBrainCoreSnapshotEnabled(raw: string | undefined = process.env.BRAIN_CORE_SNAPSHOT): boolean {
  return raw !== 'false';
}

function envMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function snapshotMaxAgeMs(raw: string | undefined = process.env.BRAIN_CORE_SNAPSHOT_MAX_AGE_HOURS): number {
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : DEFAULT_MAX_AGE_MS;
}

export function hashInstruction(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** Cut at the last line break inside the bound so no line is half-kept. */
export function boundInstruction(text: string, max: number = BRAIN_CORE_SNAPSHOT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  return nl > max / 2 ? cut.slice(0, nl + 1) : cut;
}

export function buildSnapshotValue(input: {
  core: string;
  lang?: string | null;
  builtAtMs: number;
  source: BrainCoreSnapshot['source'];
}): BrainCoreSnapshot | null {
  const text = boundInstruction(String(input.core || '').trim());
  if (!text) return null;
  return {
    version: BRAIN_CORE_SNAPSHOT_VERSION,
    role: 'community',
    lang: input.lang ?? null,
    built_at: new Date(input.builtAtMs).toISOString(),
    chars: text.length,
    hash: hashInstruction(text),
    source: input.source,
    instruction: text,
  };
}

/** Validates a stored row value; anything unexpected is treated as absent. */
export function parseSnapshotValue(value: unknown): BrainCoreSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.version !== BRAIN_CORE_SNAPSHOT_VERSION) return null;
  if (v.role !== 'community') return null;
  if (typeof v.instruction !== 'string' || !v.instruction.trim()) return null;
  if (typeof v.built_at !== 'string' || !Number.isFinite(Date.parse(v.built_at))) return null;
  return {
    version: BRAIN_CORE_SNAPSHOT_VERSION,
    role: 'community',
    lang: typeof v.lang === 'string' ? v.lang : null,
    built_at: v.built_at,
    chars: v.instruction.length,
    hash: typeof v.hash === 'string' ? v.hash : hashInstruction(v.instruction),
    source: v.source === 'finalize_refresh' ? 'finalize_refresh' : 'session_build',
    instruction: v.instruction,
  };
}

export type SnapshotRejectReason = 'absent' | 'too_old' | 'future_dated';

export function snapshotUsable(
  snap: BrainCoreSnapshot | null,
  opts: { nowMs: number; maxAgeMs?: number },
): { ok: true; ageMs: number } | { ok: false; reason: SnapshotRejectReason } {
  if (!snap) return { ok: false, reason: 'absent' };
  const ageMs = opts.nowMs - Date.parse(snap.built_at);
  if (ageMs < -60_000) return { ok: false, reason: 'future_dated' };
  if (ageMs > (opts.maxAgeMs ?? snapshotMaxAgeMs())) return { ok: false, reason: 'too_old' };
  return { ok: true, ageMs: Math.max(0, ageMs) };
}

function describeAge(ageMs: number): string {
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * The text that goes into the session. The header is an instruction to the
 * model (English intent, never spoken): what the block is, and that anything
 * date-relative in it is as of the snapshot time.
 */
export function renderSnapshotForSession(snap: BrainCoreSnapshot, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - Date.parse(snap.built_at));
  return (
    `[CORE CONTEXT SNAPSHOT — assembled ${snap.built_at} (${describeAge(ageMs)} ago) from this user's memory, ` +
    `identity and goal. The live context for this session is still loading. Treat anything date-relative ` +
    `below (today, tomorrow, upcoming, recently) as of that time, not as of now.]\n` +
    snap.instruction
  );
}

export function shouldWriteSnapshot(input: {
  existing: BrainCoreSnapshot | null;
  nextHash: string;
  nowMs: number;
  minIntervalMs?: number;
  staleRewriteMs?: number;
}): { write: boolean; reason: string } {
  const { existing } = input;
  if (!existing) return { write: true, reason: 'absent' };
  const ageMs = input.nowMs - Date.parse(existing.built_at);
  if (!Number.isFinite(ageMs) || ageMs < 0) return { write: true, reason: 'bad_timestamp' };
  if (ageMs >= (input.staleRewriteMs ?? DEFAULT_STALE_REWRITE_MS)) return { write: true, reason: 'stale' };
  if (existing.hash === input.nextHash) return { write: false, reason: 'unchanged' };
  if (ageMs < (input.minIntervalMs ?? DEFAULT_MIN_WRITE_INTERVAL_MS)) return { write: false, reason: 'throttled' };
  return { write: true, reason: 'changed' };
}

// =============================================================================
// I/O — every path fails open (a snapshot is an optimisation, never a gate).
// =============================================================================

type Repo = typeof import('./brain-core-snapshot-repository');

async function loadRepo(): Promise<Repo> {
  return import('./brain-core-snapshot-repository');
}

async function defaultSupabase(): Promise<SupabaseClient | null> {
  const { getSupabase } = await import('../../lib/supabase');
  return (getSupabase() as SupabaseClient | null) ?? null;
}

export interface SnapshotDeps {
  getSupabase?: () => Promise<SupabaseClient | null>;
  repo?: Pick<Repo, 'fetchBrainCoreSnapshotRow' | 'upsertBrainCoreSnapshotRow'>;
  nowMs?: () => number;
}

export async function readBrainCoreSnapshot(
  ids: { tenantId: string; userId: string },
  deps: SnapshotDeps & { timeoutMs?: number } = {},
): Promise<BrainCoreSnapshot | null> {
  if (!isBrainCoreSnapshotEnabled() || !ids.tenantId || !ids.userId) return null;
  const work = (async () => {
    try {
      const sb = await (deps.getSupabase ?? defaultSupabase)();
      if (!sb) return null;
      const repo = deps.repo ?? (await loadRepo());
      const { data, error } = await repo.fetchBrainCoreSnapshotRow(sb, ids.tenantId, ids.userId, BRAIN_CORE_SNAPSHOT_SIGNAL);
      if (error) {
        console.warn(`[VTID-04399] snapshot read failed: ${error.message}`);
        return null;
      }
      return parseSnapshotValue((data as { value?: unknown } | null)?.value);
    } catch (err) {
      console.warn(`[VTID-04399] snapshot read threw: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  })();
  const timeoutMs = deps.timeoutMs ?? envMs(process.env.BRAIN_CORE_SNAPSHOT_READ_TIMEOUT_MS, DEFAULT_READ_TIMEOUT_MS);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function writeBrainCoreSnapshot(
  ids: { tenantId: string; userId: string },
  value: BrainCoreSnapshot,
  deps: SnapshotDeps = {},
): Promise<boolean> {
  if (!isBrainCoreSnapshotEnabled() || !ids.tenantId || !ids.userId) return false;
  try {
    const sb = await (deps.getSupabase ?? defaultSupabase)();
    if (!sb) return false;
    const repo = deps.repo ?? (await loadRepo());
    const { error } = await repo.upsertBrainCoreSnapshotRow(sb, {
      tenant_id: ids.tenantId,
      user_id: ids.userId,
      signal_name: BRAIN_CORE_SNAPSHOT_SIGNAL,
      value,
      source: value.source,
      last_seen_at: new Date((deps.nowMs ?? Date.now)()).toISOString(),
    });
    if (error) {
      console.warn(`[VTID-04399] snapshot write failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[VTID-04399] snapshot write threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Write-through after a fresh session build. `existing` is the row this
 * session already read at start, so the throttle costs no extra read.
 */
export async function recordSnapshotAfterBuild(
  input: {
    tenantId: string;
    userId: string;
    core: string;
    lang?: string | null;
    existing: Promise<BrainCoreSnapshot | null> | BrainCoreSnapshot | null;
  },
  deps: SnapshotDeps = {},
): Promise<{ written: boolean; reason: string }> {
  if (!isBrainCoreSnapshotEnabled()) return { written: false, reason: 'disabled' };
  const nowMs = (deps.nowMs ?? Date.now)();
  const value = buildSnapshotValue({ core: input.core, lang: input.lang, builtAtMs: nowMs, source: 'session_build' });
  if (!value) return { written: false, reason: 'empty_core' };
  let existing: BrainCoreSnapshot | null = null;
  try {
    existing = await input.existing;
  } catch {
    existing = null;
  }
  const decision = shouldWriteSnapshot({ existing, nextHash: value.hash, nowMs });
  if (!decision.write) return { written: false, reason: decision.reason };
  const ok = await writeBrainCoreSnapshot({ tenantId: input.tenantId, userId: input.userId }, value, deps);
  return { written: ok, reason: ok ? decision.reason : 'write_failed' };
}

// ----------------------------------------------------------------------------
// Refresh after a session ends — delayed so the session's memory commit has
// written its facts, debounced per user so back-to-back sessions build once.
// ----------------------------------------------------------------------------

const pendingRefresh = new Map<string, NodeJS.Timeout>();

export function _pendingRefreshCountForTests(): number {
  return pendingRefresh.size;
}
export function _clearPendingRefreshForTests(): void {
  for (const t of pendingRefresh.values()) clearTimeout(t);
  pendingRefresh.clear();
}

export type BuildCoreFn = (input: {
  user_id: string;
  tenant_id: string;
  role: string;
  channel: 'orb';
  user_timezone?: string;
}) => Promise<{ coreInstruction?: string; instruction: string }>;

async function defaultBuildCore(input: Parameters<BuildCoreFn>[0]) {
  const { buildBrainSystemInstruction } = await import('../vitana-brain');
  return buildBrainSystemInstruction(input);
}

export function scheduleSnapshotRefresh(
  input: { tenantId: string; userId: string; role?: string | null; lang?: string | null; timezone?: string | null },
  deps: SnapshotDeps & { delayMs?: number; buildCore?: BuildCoreFn; onDone?: (r: { written: boolean; reason: string }) => void } = {},
): { scheduled: boolean; reason: string } {
  if (!isBrainCoreSnapshotEnabled()) return { scheduled: false, reason: 'disabled' };
  if (!input.tenantId || !input.userId) return { scheduled: false, reason: 'no_identity' };
  const role = (input.role || 'community').toLowerCase();
  if (role !== 'community') return { scheduled: false, reason: 'non_community_role' };
  const key = `${input.tenantId}|${input.userId}`;
  const prior = pendingRefresh.get(key);
  if (prior) clearTimeout(prior);
  const delayMs = deps.delayMs ?? envMs(process.env.BRAIN_CORE_SNAPSHOT_REFRESH_DELAY_MS, DEFAULT_REFRESH_DELAY_MS);
  const timer = setTimeout(() => {
    pendingRefresh.delete(key);
    void (async () => {
      let result: { written: boolean; reason: string };
      try {
        const built = await (deps.buildCore ?? defaultBuildCore)({
          user_id: input.userId,
          tenant_id: input.tenantId,
          role: 'community',
          channel: 'orb',
          user_timezone: input.timezone ?? undefined,
        });
        const nowMs = (deps.nowMs ?? Date.now)();
        const value = buildSnapshotValue({
          core: built.coreInstruction ?? '',
          lang: input.lang ?? null,
          builtAtMs: nowMs,
          source: 'finalize_refresh',
        });
        if (!value) {
          result = { written: false, reason: 'empty_core' };
        } else {
          const ok = await writeBrainCoreSnapshot({ tenantId: input.tenantId, userId: input.userId }, value, deps);
          result = { written: ok, reason: ok ? 'refreshed' : 'write_failed' };
        }
      } catch (err) {
        console.warn(`[VTID-04399] snapshot refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        result = { written: false, reason: 'build_failed' };
      }
      deps.onDone?.(result);
    })();
  }, delayMs);
  timer.unref?.();
  pendingRefresh.set(key, timer);
  return { scheduled: true, reason: prior ? 'rescheduled' : 'scheduled' };
}

// ----------------------------------------------------------------------------
// The stream-open gate's fallback step.
// ----------------------------------------------------------------------------

export interface CoreFallbackSession {
  contextInstruction?: string;
  coreContextFallback?: Promise<string | null>;
  contextSource?: 'fresh' | 'snapshot' | 'none';
}

/**
 * Called by the gate after the fresh-context race. If the fresh build has not
 * populated the session, wait (bounded) for the snapshot read and use it.
 * Never overwrites a context the fresh build already wrote.
 */
export async function applyCoreContextFallback(
  session: CoreFallbackSession,
  waitMs: number,
): Promise<{ source: 'fresh' | 'snapshot' | 'none'; chars: number }> {
  if (session.contextInstruction && session.contextInstruction.length > 0) {
    session.contextSource = 'fresh';
    return { source: 'fresh', chars: session.contextInstruction.length };
  }
  const pending = session.coreContextFallback;
  if (!pending) {
    session.contextSource = 'none';
    return { source: 'none', chars: 0 };
  }
  let timer: NodeJS.Timeout | undefined;
  let text: string | null = null;
  try {
    text = await Promise.race([
      pending.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, waitMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // The fresh build may have landed while we waited — it wins.
  if (session.contextInstruction && session.contextInstruction.length > 0) {
    session.contextSource = 'fresh';
    return { source: 'fresh', chars: session.contextInstruction.length };
  }
  if (text && text.length > 0) {
    session.contextInstruction = text;
    session.contextSource = 'snapshot';
    return { source: 'snapshot', chars: text.length };
  }
  session.contextSource = 'none';
  return { source: 'none', chars: 0 };
}
