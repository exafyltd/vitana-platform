/**
 * VTID-04480 — guards against the runaway opening turn.
 *
 * Seen live on staging twice (2026-09-22 22:16 and 2026-09-24 12:49): a
 * resume greeting (`conv_resume`) made Nova "look around" with tools before
 * saying anything — five calls in a row (get_current_screen, then every
 * data tool the screen offered). The loop guard answered the sixth call,
 * and Nova then spoke for ~70 s without stopping, reading back the tool
 * payloads (JSON keys, screen ids, UUIDs). The member heard backend data.
 *
 * Three guards, all pure and small, used by the shared session handlers
 * (Nova, the cascade, and the Vertex bridge with shared handlers):
 *
 *   1. Opening-turn tool budget — before the first word of a session, at
 *      most `openingTurnMaxToolCalls()` tool calls; the next one gets the
 *      loop guard's speak-now guidance. The general loop-guard limit still
 *      applies to every other turn.
 *   2. Reply cap after the loop guard — the guidance asks for ONE short
 *      sentence, so the reply that follows is capped at
 *      `loopGuardReplyMaxAudioMs()` of audio; the rest of that turn is
 *      muted.
 *   3. Backend-data detector — the model's own transcript of what it is
 *      saying is checked for things no spoken sentence contains (JSON
 *      braces or keys, snake_case identifiers, UUIDs, dotted upper-case
 *      screen ids). On a match the rest of the turn is muted.
 *
 * Nothing here composes speech.
 */

const OPENING_DEFAULT = 2;
const OPENING_MIN = 1;
const OPENING_MAX = 5;

/** `ORB_OPENING_MAX_TOOL_CALLS`, clamped 1–5; unset or garbage → 2. */
export function openingTurnMaxToolCalls(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ORB_OPENING_MAX_TOOL_CALLS);
  if (!Number.isFinite(n) || n <= 0) return OPENING_DEFAULT;
  return Math.min(OPENING_MAX, Math.max(OPENING_MIN, Math.round(n)));
}

/** The opening turn: nothing has been said by either side yet. */
export function isOpeningTurn(session: { turn_count?: number; isModelSpeaking?: boolean }): boolean {
  return (session.turn_count ?? 0) === 0 && !session.isModelSpeaking;
}

/** The tool-call limit that applies to this session right now. */
export function effectiveToolCallLimit(
  session: { turn_count?: number; isModelSpeaking?: boolean },
  baseLimit: number,
  env: Record<string, string | undefined> = process.env,
): { limit: number; opening: boolean } {
  if (!isOpeningTurn(session)) return { limit: baseLimit, opening: false };
  return { limit: Math.min(baseLimit, openingTurnMaxToolCalls(env)), opening: true };
}

const REPLY_CAP_DEFAULT_MS = 20_000;
const REPLY_CAP_MIN_MS = 5_000;
const REPLY_CAP_MAX_MS = 60_000;

/** `ORB_LOOP_GUARD_REPLY_MAX_MS`, clamped 5–60 s; unset or garbage → 20 s. */
export function loopGuardReplyMaxAudioMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ORB_LOOP_GUARD_REPLY_MAX_MS);
  if (!Number.isFinite(n) || n <= 0) return REPLY_CAP_DEFAULT_MS;
  return Math.min(REPLY_CAP_MAX_MS, Math.max(REPLY_CAP_MIN_MS, Math.round(n)));
}

/**
 * Playback length of one PCM16 mono chunk. The rate comes from the chunk's
 * mime type (`audio/pcm;rate=16000`); Nova's 24 kHz is the default.
 */
export function pcmChunkDurationMs(dataB64: string, mimeType?: string): number {
  const m = /rate=(\d+)/.exec(mimeType || '');
  const rate = m ? Number(m[1]) : 24_000;
  if (!rate || !dataB64) return 0;
  const padding = dataB64.endsWith('==') ? 2 : dataB64.endsWith('=') ? 1 : 0;
  const bytes = Math.max(0, (dataB64.length * 3) / 4 - padding);
  return (bytes / 2 / rate) * 1000;
}

export type BackendLeakKind = 'json' | 'snake_case_key' | 'uuid' | 'screen_id';

const LEAK_PATTERNS: Array<{ kind: BackendLeakKind; re: RegExp }> = [
  { kind: 'json', re: /[{}]|"[A-Za-z_][A-Za-z0-9_]*"\s*:/ },
  { kind: 'uuid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { kind: 'screen_id', re: /\b[A-Z]{3,}(?:\.[A-Z][A-Z0-9_]{1,}){1,}\b/ },
  { kind: 'snake_case_key', re: /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9]\b/ },
];

/**
 * Returns the kind of backend data found in spoken text, or null. Speech
 * never contains braces, JSON keys, snake_case identifiers, UUIDs or dotted
 * upper-case ids, in any language, so a match means the model is reading a
 * payload aloud.
 */
export function detectBackendDataLeak(text: string): BackendLeakKind | null {
  if (!text) return null;
  for (const p of LEAK_PATTERNS) {
    if (p.re.test(text)) return p.kind;
  }
  return null;
}

/** Bounded preview of what the model said in a turn, for the turn_complete diag. */
export function outputPreview(text: string, max = 240): string | null {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
