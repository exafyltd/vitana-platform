/**
 * VTID-04309 — Command Hub voice turns belong to the Operator Console thread.
 *
 * The Command Hub loads the same voice widget as the community app. Before
 * this, a developer's voice conversation was written into the member's
 * community "Vitana" inbox DM (VTID-CHAT-BRIDGE → chat_messages) and never
 * reached the Operator Console, so there was no single place to scroll back
 * through what was discussed with the developer assistant.
 *
 * Now, on the command-hub surface:
 *   - each finished turn is recorded into `operator_threads` /
 *     `operator_messages` under the console thread the widget was bound to
 *     (`operator_thread_id` on the start payload), marked `channel: 'voice'`;
 *   - the community inbox bridge is skipped entirely — developer voice is
 *     not a community conversation.
 * The community surface is byte-for-byte unchanged.
 */
import { resolveOrbSurface } from '../surface';
import { recordOperatorTurn, maybeSummarizeThread, isOperatorThreadsEnabled } from '../../../services/operator-threads';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The thread id to bind, or null: must be a UUID and the route must be the Command Hub. */
export function resolveOperatorThreadIdForVoice(raw: unknown, currentRoute: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) return null;
  return resolveOrbSurface({ currentRoute: currentRoute ?? null }) === 'command-hub' ? raw.toLowerCase() : null;
}

export interface VoiceThreadSession {
  sessionId: string;
  current_route?: string;
  operator_thread_id?: string;
  turn_count?: number;
  lang?: string;
  active_role?: string | null;
  identity?: { user_id?: string | null; tenant_id?: string | null; role?: string | null } | null;
}

export function isCommandHubVoiceSession(session: Pick<VoiceThreadSession, 'current_route'>): boolean {
  return ((session as any).assistantProfile ? (session as any).assistantProfile.surface : resolveOrbSurface({ currentRoute: session.current_route ?? null })) === 'command-hub';
}

/**
 * Route one finished voice turn. Returns true when the session is a Command
 * Hub session — the caller must then skip the community inbox bridge.
 * Recording is fire-and-forget and never throws.
 */
export function recordCommandHubVoiceTurn(
  session: VoiceThreadSession,
  userText: string,
  assistantText: string,
  record: typeof recordOperatorTurn = recordOperatorTurn,
): boolean {
  if (!isCommandHubVoiceSession(session)) return false;
  const threadId = session.operator_thread_id;
  const user = (userText || '').trim();
  const reply = (assistantText || '').trim();
  if (!threadId || (!user && !reply) || !isOperatorThreadsEnabled()) return true;
  record({
    threadId,
    identity: {
      user_id: session.identity?.user_id ?? null,
      tenant_id: session.identity?.tenant_id ?? null,
      role: session.active_role ?? session.identity?.role ?? null,
    },
    userText: user,
    reply,
    meta: { channel: 'voice', orb_session_id: session.sessionId, turn_index: session.turn_count ?? null, voice_language: session.lang ?? null },
  })
    .then((r) => (r.recorded ? maybeSummarizeThread(threadId, r.turns) : false))
    .catch((err) => console.warn('[VTID-04309] voice turn record failed:', err instanceof Error ? err.message : err));
  return true;
}
