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
}

export interface PrewarmedNovaSessionEntry extends PrewarmedNovaSessionBase {
  createdAt: number;
  keepaliveTimer: ReturnType<typeof setInterval>;
  expiryTimer: ReturnType<typeof setTimeout>;
}

const prewarmedByUserId = new Map<string, PrewarmedNovaSessionEntry>();

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
 * True when a still-open, unclaimed prewarm already exists for this user.
 * Callers can use this to skip the expensive connect() + system-instruction
 * assembly entirely on a redundant prewarm attempt (see BOOTSTRAP-NOVA-
 * PREWARM-REGISTRY-HARDEN) instead of paying that cost only to have
 * `registerPrewarmedNovaSession` discard the result.
 */
export function hasLivePrewarmedNovaSession(userId: string): boolean {
  const existing = prewarmedByUserId.get(userId);
  return !!existing && existing.client.getState() === 'open';
}

/**
 * Register an already-connected Nova client as this user's prewarmed
 * session. Arms the idle-keepalive (so Bedrock's no-audio close never fires
 * while nobody has claimed it) and the TTL expiry.
 *
 * BOOTSTRAP-NOVA-PREWARM-REGISTRY-HARDEN: if a still-open, unclaimed entry
 * is already registered for this user, KEEP it and close/discard `base`
 * instead of the reverse. This used to unconditionally replace the existing
 * entry — safe for the intended "stale prewarm, page refresh" case, but a
 * real, reproducible failure mode for the case this registry's own header
 * comment already names as accepted risk (two browser tabs/frames for the
 * same user — confirmed live via /admin/device-preview, which iframes the
 * app for the same logged-in user, and independently plausible from a
 * widget re-init firing a second prewarm before the first settled): each
 * new attempt reset the "ready" clock to zero, so a real tap could arrive
 * while the CURRENT attempt's ~5-8s connect was still in flight even though
 * an earlier attempt had already finished and was sitting there unclaimed.
 * Measured on staging: 11 successful prewarms in 45 minutes for two users,
 * zero claims, ever. Claiming is by user_id (see consumePrewarmedNovaSession),
 * not by socket/tab, so keeping the OLDER entry is always safe — whichever
 * tab's real session-start arrives first still claims correctly.
 */
export function registerPrewarmedNovaSession(userId: string, base: PrewarmedNovaSessionBase): void {
  if (hasLivePrewarmedNovaSession(userId)) {
    void base.client.close('prewarm_superseded_kept_existing').catch(() => { /* best-effort */ });
    return;
  }
  discardPrewarmedNovaSession(userId, 'superseded_by_new_prewarm');

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
    void entry.client.close('prewarm_claim_found_dead').catch(() => { /* best-effort */ });
    return null;
  }
  return entry;
}

/** Test-only: drop every pooled entry without closing (unit tests construct
 *  fake clients that don't need a real close). Never call from real code. */
export function __clearAllPrewarmedNovaSessionsForTest(): void {
  for (const entry of prewarmedByUserId.values()) stopTimers(entry);
  prewarmedByUserId.clear();
}

/** Test-only: current pool size. */
export function __prewarmedNovaSessionCountForTest(): number {
  return prewarmedByUserId.size;
}
