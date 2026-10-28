/**
 * VTID-03779 — Nova Sonic session pre-establishment ("warm start").
 *
 * Real staging measurement (VTID-03764) found authenticated ORB sessions
 * take ~5-8s to first audio while anonymous sessions (near-zero context, a
 * 1-2 tool catalog instead of the full ~390-declaration authenticated set)
 * take ~0.7-1.7s — the gap tracks with the size of the system
 * instruction + tool catalog Nova has to process at connect time, not with
 * anything content-specific. Trimming that catalog carries real regression
 * risk (a tool not declared is a tool Nova cannot call), so instead of
 * shrinking the cold-start payload, this does the expensive part — opening
 * the Nova connection with the REAL system instruction and REAL tool
 * catalog — in the background, before the user has opened the ORB overlay
 * at all. When they do tap it, the real session-start path claims this
 * already-open connection instead of connecting fresh: a cold start becomes
 * a warm one.
 *
 * This module is deliberately just the storage/lifecycle mechanism — it
 * never decides whether prewarming is enabled (callers gate that via
 * `isFeatureLive`) and never builds the system instruction/tools itself
 * (callers pass an already-connected client). Keeping the two separate lets
 * this module be tested without dragging in the real context-assembly
 * pipeline.
 *
 * Registry is a plain in-process Map keyed by user_id — safe DESPITE the
 * gateway running multiple ECS tasks behind a non-sticky ALB, because a
 * prewarm and the real claim that later consumes it are always two messages
 * on the SAME already-open WebSocket connection, which by construction is
 * handled by a single process throughout its lifetime. There is no
 * cross-instance handoff to get wrong. The one accepted gap: two browser
 * tabs for the same user landing on different ECS tasks each get their own
 * map entry (last prewarm registered on a given task wins on that task) —
 * never a correctness problem, at worst a missed warm-start on one tab.
 */

import type { NovaSonicLiveClient } from '../upstream/nova-sonic-live-client';
import { SILENCE_AUDIO_B64 } from '../../upstream/constants';

/** Well under Bedrock's ~15s no-audio close — leaves ample margin for a
 *  slow event-loop tick without ever letting the connection go idle-dead
 *  while it waits to be claimed. */
const PREWARM_KEEPALIVE_INTERVAL_MS = 5_000;

/** How long an unclaimed prewarmed connection is kept alive before being
 *  closed. Long enough to cover "log in, glance around, tap ORB"; short
 *  enough to bound the extra Bedrock connection-time cost of a prewarm the
 *  user never actually uses. Env-tunable without a redeploy. */
function getPrewarmTtlMs(): number {
  const raw = Number(process.env.ORB_NOVA_PREWARM_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90_000;
}

export interface PrewarmedNovaSessionBase {
  client: NovaSonicLiveClient;
  /** Exact string sent as Nova's system instruction at connect time —
   *  carried forward so the claim path can populate the same diagnostic
   *  fields (_novaInstructionChars etc.) the cold path always has. */
  systemInstruction: string;
  tools: Array<Record<string, unknown>>;
  voiceId: string;
  lang: string;
  /** VTID-04554: fingerprint of what the stream was opened with
   *  (prewarm-fingerprint.ts). Set only by the full-context prewarm
   *  (`ORB_PREWARM_FULL_CONTEXT_ENABLED`); the session claims such an entry
   *  only when its own cold envelope has the same fingerprint. */
  fingerprint?: string;
}

export interface PrewarmedNovaSessionEntry extends PrewarmedNovaSessionBase {
  createdAt: number;
  keepaliveTimer: ReturnType<typeof setInterval>;
  expiryTimer: ReturnType<typeof setTimeout>;
}

const prewarmedByUserId = new Map<string, PrewarmedNovaSessionEntry>();

/**
 * VTID-04542 — why the LAST prewarm for a user is gone, so a claim that finds
 * nothing can say whether one existed. Telemetry only: nothing here decides
 * whether a session claims a prewarm. Cleared when a new prewarm registers or
 * one is claimed. Bounded (oldest dropped) so it cannot grow without limit.
 */
export type PrewarmEndReason = 'expired' | 'dead_on_claim';
const PREWARM_END_REASON_CAP = 5_000;
const lastEndReasonByUserId = new Map<string, PrewarmEndReason>();

function recordPrewarmEnd(userId: string, reason: PrewarmEndReason): void {
  lastEndReasonByUserId.delete(userId);
  lastEndReasonByUserId.set(userId, reason);
  if (lastEndReasonByUserId.size > PREWARM_END_REASON_CAP) {
    const oldest = lastEndReasonByUserId.keys().next().value;
    if (oldest !== undefined) lastEndReasonByUserId.delete(oldest);
  }
}

/**
 * VTID-04542 — after a claim returned null: `'expired'` when this user's last
 * prewarm hit its TTL, `'dead_on_claim'` when the claim found it closed, else
 * `'none_available'` (never prewarmed on this task, or superseded). Read-only.
 */
export function describePrewarmMiss(userId: string): PrewarmEndReason | 'none_available' {
  return lastEndReasonByUserId.get(userId) ?? 'none_available';
}

function stopTimers(entry: Pick<PrewarmedNovaSessionEntry, 'keepaliveTimer' | 'expiryTimer'>): void {
  clearInterval(entry.keepaliveTimer);
  clearTimeout(entry.expiryTimer);
}

/**
 * Discard (and close) any existing prewarmed entry for this user. Called
 * before registering a new one so a second prewarm (multi-tab, a re-login,
 * a page refresh) never leaks the first connection.
 */
export function discardPrewarmedNovaSession(userId: string, reason: string): void {
  const existing = prewarmedByUserId.get(userId);
  if (!existing) return;
  prewarmedByUserId.delete(userId);
  stopTimers(existing);
  void existing.client.close(reason).catch(() => { /* best-effort — already tearing down */ });
}

/**
 * Register an already-connected Nova client as this user's prewarmed
 * session. Arms the idle-keepalive (so Bedrock's no-audio close never fires
 * while nobody has claimed it) and the TTL expiry.
 */
export function registerPrewarmedNovaSession(userId: string, base: PrewarmedNovaSessionBase): void {
  discardPrewarmedNovaSession(userId, 'superseded_by_new_prewarm');
  lastEndReasonByUserId.delete(userId);

  const keepaliveTimer = setInterval(() => {
    if (base.client.getState() !== 'open') return;
    try {
      base.client.sendAudioChunk(SILENCE_AUDIO_B64, 'audio/pcm;rate=16000');
    } catch {
      /* connection closing under us — the expiry/claim path will notice */
    }
  }, PREWARM_KEEPALIVE_INTERVAL_MS);
  keepaliveTimer.unref?.();

  const expiryTimer = setTimeout(() => {
    // Re-read from the map rather than closing over `entry` directly: if
    // this user's prewarm was already claimed or superseded, the map no
    // longer holds THIS entry and there is nothing left to expire.
    const current = prewarmedByUserId.get(userId);
    if (current && current.client === base.client) {
      prewarmedByUserId.delete(userId);
      stopTimers(current);
      recordPrewarmEnd(userId, 'expired');
      void current.client.close('prewarm_ttl_expired').catch(() => { /* best-effort */ });
    }
  }, getPrewarmTtlMs());
  expiryTimer.unref?.();

  prewarmedByUserId.set(userId, { ...base, createdAt: Date.now(), keepaliveTimer, expiryTimer });
}

/**
 * Claim (pop) a still-open prewarmed session for this user, if one exists.
 * Returns null — never throws — when there is nothing to claim, so every
 * caller can unconditionally fall through to the normal cold-connect path.
 */
export function consumePrewarmedNovaSession(userId: string): PrewarmedNovaSessionEntry | null {
  const entry = prewarmedByUserId.get(userId);
  if (!entry) return null;
  prewarmedByUserId.delete(userId);
  stopTimers(entry);
  if (entry.client.getState() !== 'open') {
    // Died between prewarm and claim (an idle-kill despite the keepalive, a
    // transient network blip) — the caller does a normal cold connect.
    recordPrewarmEnd(userId, 'dead_on_claim');
    void entry.client.close('prewarm_claim_found_dead').catch(() => { /* best-effort */ });
    return null;
  }
  lastEndReasonByUserId.delete(userId);
  return entry;
}

/**
 * VTID-04554: read this user's pooled entry without claiming it, so the
 * session can compare fingerprints first and leave the entry pooled when it
 * must not be claimed now (a guided-topic open). Null when nothing is pooled.
 */
export function peekPrewarmedNovaSession(userId: string): PrewarmedNovaSessionEntry | null {
  return prewarmedByUserId.get(userId) ?? null;
}

/** Test-only: drop every pooled entry without closing (unit tests construct
 *  fake clients that don't need a real close). Never call from real code. */
export function __clearAllPrewarmedNovaSessionsForTest(): void {
  for (const entry of prewarmedByUserId.values()) stopTimers(entry);
  prewarmedByUserId.clear();
  lastEndReasonByUserId.clear();
}

/** Test-only: current pool size. */
export function __prewarmedNovaSessionCountForTest(): number {
  return prewarmedByUserId.size;
}
