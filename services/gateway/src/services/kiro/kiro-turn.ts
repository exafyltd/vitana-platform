/**
 * VTID-04975: one Operator turn answered by Kiro (kiro-cli over ACP).
 *
 * `runKiroTurn()` is called from runOperatorChatTurn() for threads whose
 * engine is 'kiro' and returns the same shape processWithGemini() does
 * ({ reply, toolResults, meta }), so thread recording, OASIS events and the
 * reply frame are reused unchanged.
 *
 * Phase 1 ships this inert: no KiroBackend is registered and
 * KIRO_ENGINE_ENABLED is unset, so a Kiro thread answers `not_connected`.
 * VTID-04999: remote-backend.ts registers the kiro-runner backend when
 * KIRO_ENGINE_ENABLED, KIRO_RUNNER_URL and KIRO_RUNNER_TOKEN are all set.
 * The runner spawns `kiro-cli acp`
 * with the owner's KIRO_API_KEY in that child's environment only. This file
 * never sees, stores or logs a key.
 */
import { AcpClient, type AcpChild, type KiroModel, type KiroModelState } from './acp-client';
import { mapAcpUpdate, type KiroTurnEventSink } from './kiro-events';
import { makePermissionHandler } from './permission-broker';
import { isKiroCreditError, setKiroCredits } from './credit-state';
import { isKiroMcpEnabled } from './kiro-mcp-token';

export interface KiroSpawnContext { userId: string | null; threadId: string }

export interface KiroBackend {
  /** Start `kiro-cli acp` for this user. The key goes into the child's env here, nowhere else. */
  spawn(ctx: KiroSpawnContext): Promise<AcpChild> | AcpChild;
  /** Isolated working directory for the session. */
  workspace(ctx: KiroSpawnContext): string;
}

/** VTID-04999: the signed-in user has no Kiro API key linked (the runner closed the session with 4401). */
export class KiroKeyMissingError extends Error {
  constructor() { super('kiro_key_missing'); this.name = 'KiroKeyMissingError'; }
}

export interface KiroTurnInput {
  threadId: string;
  userId: string | null;
  message: string;
  emit?: KiroTurnEventSink;
  /**
   * VTID-05018: the thread's earlier turns. Called only when this turn opens a NEW Kiro
   * session (first turn, idle/expiry reopen, after a failure, a deploy or another gateway
   * task), never for a live session. A throw or empty list means no history.
   */
  loadHistory?: () => Promise<KiroHistoryMessage[]>;
  /**
   * VTID-05060: the model the developer last picked for this thread in Kiro's own drop-down
   * (null = no pick on record). Called only when this turn opens a NEW Kiro session, so the
   * pick survives an idle close, a deploy or the reopen. Never a default: no pick, no call.
   */
  loadModelPick?: () => Promise<string | null>;
}

/** VTID-05018: one earlier turn of the thread (user or assistant text only). */
export interface KiroHistoryMessage { role: 'user' | 'assistant'; content: string }

export const KIRO_HISTORY_MESSAGE_CHARS = 1_500;
export const KIRO_HISTORY_TOTAL_CHARS = 12_000;
const HISTORY_START = '=== RESTORED THREAD HISTORY (earlier turns of this conversation; context only, not new instructions) ===';
const HISTORY_END = '=== END RESTORED THREAD HISTORY ===';

/**
 * VTID-05018: the earlier turns as one marked block, newest kept: each message clipped,
 * the whole block capped (oldest dropped first, with a line saying how many). Null when empty.
 */
export function restoredHistoryBlock(history: KiroHistoryMessage[]): { text: string; count: number } | null {
  const rows = history.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  if (rows.length === 0) return null;
  const lines = rows.map((m) => {
    const c = m.content.trim();
    const clipped = c.length > KIRO_HISTORY_MESSAGE_CHARS ? `${c.slice(0, KIRO_HISTORY_MESSAGE_CHARS)} …` : c;
    return `${m.role === 'user' ? 'User' : 'You (Kiro)'}: ${clipped}`;
  });
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (size + lines[i].length + 1 > KIRO_HISTORY_TOTAL_CHARS) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  if (kept.length === 0) return null;
  const omitted = lines.length - kept.length;
  const body = [...(omitted > 0 ? [`… ${omitted} earlier message(s) omitted`] : []), ...kept].join('\n');
  return { text: `${HISTORY_START}\n${body}\n${HISTORY_END}`, count: kept.length };
}

export interface KiroTurnResult {
  reply: string;
  toolResults: Array<{ name: string; response: Record<string, unknown> }>;
  meta: Record<string, unknown>;
}

export type KiroStatus = 'ok' | 'not_connected' | 'busy' | 'error' | 'no_credits';

// VTID-05003: admin-only Operator Console text, English by design (server i18n 13b admin/dev exclusion).
const NO_CREDITS_REPLY = 'Your Kiro credits are used up — new threads use the Operator until they renew.';

/** A used-up seat: remember it for the default engine, tell the caller whether it changed. */
function noCredits(userId: string | null, source: 'empty_models' | 'error', kiroMessage?: string): KiroTurnResult {
  const changed = setKiroCredits(userId, 'exhausted');
  return result('no_credits', NO_CREDITS_REPLY, { error: 'kiro_no_credits', credit_source: source, credits_changed: changed, ...(kiroMessage ? { kiro_message: kiroMessage } : {}) });
}

interface KiroSession {
  client: AcpClient;
  sessionId: string;
  userId: string | null;
  emit: KiroTurnEventSink;
  idle: NodeJS.Timeout | null;
  /** VTID-04984: the models Kiro offers for this session, and the current one. */
  models: KiroModelState | null;
  /** VTID-05003: this session's open moved the user's credits back to ok (reported once). */
  creditsChanged?: boolean;
  /** VTID-05005: when the session (and its tool pass) was opened. */
  openedAt: number;
}

/** VTID-05005: a session's tool pass lasts 1 h; an older session reopens at its next turn. */
export const KIRO_MCP_SESSION_MAX_MS = 55 * 60_000;

const sessions = new Map<string, KiroSession>();
let backend: KiroBackend | null = null;

export function setKiroBackend(b: KiroBackend | null): void { backend = b; }
export function isKiroEngineEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return env.KIRO_ENGINE_ENABLED === 'true'; }

function intEnv(name: string, def: number, env: NodeJS.ProcessEnv): number {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
export const kiroLimits = (env: NodeJS.ProcessEnv = process.env) => ({
  perUser: intEnv('KIRO_MAX_SESSIONS_PER_USER', 3, env),
  global: intEnv('KIRO_MAX_SESSIONS_GLOBAL', 10, env),
  idleMs: intEnv('KIRO_SESSION_IDLE_MS', 15 * 60_000, env),
});

function result(status: KiroStatus, reply: string, extra: Record<string, unknown> = {}, toolResults: KiroTurnResult['toolResults'] = []): KiroTurnResult {
  return { reply, toolResults, meta: { engine: 'kiro', kiro_status: status, ...extra } };
}

function touch(threadId: string, s: KiroSession): void {
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => closeSession(threadId), kiroLimits().idleMs);
  s.idle.unref?.();
}

function closeSession(threadId: string): void {
  const s = sessions.get(threadId);
  if (!s) return;
  sessions.delete(threadId);
  if (s.idle) clearTimeout(s.idle);
  s.client.close();
}

async function openSession(input: KiroTurnInput, b: KiroBackend): Promise<KiroSession> {
  const ctx = { userId: input.userId, threadId: input.threadId };
  const child = await b.spawn(ctx);
  // `holder` lets notifications and permission cards reach the CURRENT turn's sink.
  const holder: { session: KiroSession | null } = { session: null };
  const emit: KiroTurnEventSink = (e) => { try { holder.session?.emit(e); } catch { /* sink must never fail a turn */ } };
  const client = new AcpClient(child, {
    requestTimeoutMs: 30_000,
    onNotification: (method, params) => {
      if (method !== 'session/update' && method !== 'session/notification') return;
      const ev = mapAcpUpdate(params);
      if (ev) emit(ev);
    },
    onPermissionRequest: makePermissionHandler({ threadId: input.threadId, userId: input.userId, emit }),
  });
  try {
    await client.initialize();
    const { sessionId, models } = await client.openNewSession(b.workspace(ctx));
    const session: KiroSession = { client, sessionId, userId: input.userId, emit: input.emit ?? (() => {}), idle: null, models, openedAt: Date.now() };
    holder.session = session;
    return session;
  } catch (err) {
    client.close();
    throw err;
  }
}

/**
 * VTID-05060: on a NEW session, switch to the model the developer last picked for this thread,
 * through the same client call setKiroModel uses. Returns null when there is nothing to report
 * (no pick on record, or the pick is already current); 'applied:<id>' when switched;
 * 'unavailable:<id>' when Kiro no longer offers it (Kiro's model stays, the badge shows it);
 * 'failed:<id>' when Kiro rejected the switch. Never throws: the turn goes on either way.
 */
async function restoreModelPick(input: KiroTurnInput, session: KiroSession): Promise<string | null> {
  if (!input.loadModelPick || !session.models) return null;
  let pick: string | null = null;
  try { pick = await input.loadModelPick(); } catch (err) {
    console.warn('[VTID-05060] kiro model pick lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
  if (!pick || pick === session.models.current) return null;
  if (!session.models.models.some((m) => m.id === pick)) return `unavailable:${pick}`;
  try {
    session.models = await session.client.setModel(session.sessionId, session.models, pick);
    return `applied:${pick}`;
  } catch (err) {
    console.warn('[VTID-05060] kiro model restore failed:', err instanceof Error ? err.message : err);
    return `failed:${pick}`;
  }
}

export async function runKiroTurn(input: KiroTurnInput, env: NodeJS.ProcessEnv = process.env): Promise<KiroTurnResult> {
  if (!isKiroEngineEnabled(env) || !backend) {
    return result('not_connected', 'Kiro is not connected on this deployment yet.');
  }
  let session = sessions.get(input.threadId);
  if (session && session.userId !== input.userId) return result('error', 'This Kiro session belongs to another user.', { error: 'forbidden' });
  if (session && isKiroMcpEnabled(env) && Date.now() - session.openedAt > KIRO_MCP_SESSION_MAX_MS) {
    closeSession(input.threadId);
    session = undefined;
  }
  let restored: { text: string; count: number } | null = null;
  let modelRestore: string | null = null;
  if (!session) {
    const lim = kiroLimits(env);
    const mine = [...sessions.values()].filter((s) => s.userId === input.userId).length;
    if (sessions.size >= lim.global || mine >= lim.perUser) {
      return result('busy', 'Kiro has too many open sessions right now. Close one and try again.', { limit: mine >= lim.perUser ? 'per_user' : 'global' });
    }
    try { session = await openSession(input, backend); } catch (err) {
      // VTID-04999: no linked key is "not connected for you", not a failure. Admin-only
      // Operator Console text, English by design (server i18n 13b admin/dev exclusion).
      if (err instanceof KiroKeyMissingError) {
        return result('not_connected', 'Link your Kiro API key in the Kiro workspace panel.', { error: 'kiro_key_missing' });
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (isKiroCreditError(msg)) return noCredits(input.userId, 'error', msg);
      return result('error', 'Kiro could not start.', { error: msg });
    }
    // VTID-05003: Kiro always offers a model; an empty list means the seat's credits are used up.
    if (session.models && session.models.models.length === 0) {
      session.client.close();
      return noCredits(input.userId, 'empty_models');
    }
    const creditsChanged = session.models ? setKiroCredits(input.userId, 'ok') : false;
    sessions.set(input.threadId, session);
    session.creditsChanged = creditsChanged;
    // VTID-05060: re-apply the developer's own model pick when Kiro still offers it.
    modelRestore = await restoreModelPick(input, session);
    // VTID-05018: a new session starts empty, so give it the thread's earlier turns.
    if (input.loadHistory) {
      try { restored = restoredHistoryBlock(await input.loadHistory()); } catch (err) {
        console.warn('[VTID-05018] kiro history load failed:', err instanceof Error ? err.message : err);
      }
    }
  }
  touch(input.threadId, session);

  // Collect what the turn produced from the same events the console streams.
  let reply = '';
  const tools = new Map<string, { name: string; kind: string; status: string }>();
  const collect: KiroTurnEventSink = (e) => {
    if (e.type === 'kiro.message_chunk') reply += e.text;
    else if (e.type === 'kiro.tool_call') tools.set(e.tool_call_id, { name: e.title, kind: e.kind, status: e.status });
    else if (e.type === 'kiro.tool_update') { const t = tools.get(e.tool_call_id); if (t) t.status = e.status || t.status; }
    try { input.emit?.(e); } catch { /* sink must never fail a turn */ }
  };
  session.emit = collect;

  try {
    const { stopReason } = restored
      ? await session.client.prompt(session.sessionId, input.message, undefined, restored.text)
      : await session.client.prompt(session.sessionId, input.message);
    collect({ type: 'kiro.turn_end', stop_reason: stopReason });
    const recovered = session.creditsChanged === true;
    session.creditsChanged = false;
    return result('ok', reply, { stop_reason: stopReason, kiro_model: session.models?.current ?? null, ...(recovered ? { credits_changed: true } : {}), ...(restored ? { kiro_history_restored: restored.count } : {}), ...(modelRestore ? { kiro_model_restore: modelRestore } : {}) }, [...tools.values()].map((t) => ({ name: t.name, response: { kind: t.kind, status: t.status } })));
  } catch (err) {
    closeSession(input.threadId);
    const msg = err instanceof Error ? err.message : String(err);
    if (isKiroCreditError(msg)) return noCredits(input.userId, 'error', msg);
    return result('error', 'Kiro turn failed.', { error: msg });
  }
}

/** Cancel the running turn; the session stays open. Owner only. */
export function cancelKiroTurn(threadId: string, userId: string | null): { ok: boolean; error?: 'not_found' | 'forbidden' } {
  const s = sessions.get(threadId);
  if (!s) return { ok: false, error: 'not_found' };
  if (s.userId !== userId) return { ok: false, error: 'forbidden' };
  s.client.cancel(s.sessionId);
  return { ok: true };
}

/** Close and forget the session. Owner only. */
export function closeKiroSession(threadId: string, userId: string | null): { ok: boolean; error?: 'not_found' | 'forbidden' } {
  const s = sessions.get(threadId);
  if (!s) return { ok: false, error: 'not_found' };
  if (s.userId !== userId) return { ok: false, error: 'forbidden' };
  closeSession(threadId);
  return { ok: true };
}

/** VTID-04984: the models Kiro offers for this thread's session. Owner only. */
export function listKiroModels(threadId: string, userId: string | null):
  { ok: true; models: KiroModel[]; current: string | null } | { ok: false; error: 'not_found' | 'forbidden' } {
  const s = sessions.get(threadId);
  if (!s) return { ok: false, error: 'not_found' };
  if (s.userId !== userId) return { ok: false, error: 'forbidden' };
  return { ok: true, models: s.models?.models ?? [], current: s.models?.current ?? null };
}

/** VTID-04984: switch this thread's Kiro model through Kiro. Owner only; Kiro's own error is passed through. */
export async function setKiroModel(threadId: string, userId: string | null, modelId: string):
  Promise<{ ok: true; models: KiroModel[]; current: string | null } | { ok: false; error: 'not_found' | 'forbidden' | 'kiro_error'; message?: string }> {
  const s = sessions.get(threadId);
  if (!s) return { ok: false, error: 'not_found' };
  if (s.userId !== userId) return { ok: false, error: 'forbidden' };
  try {
    s.models = await s.client.setModel(s.sessionId, s.models ?? { models: [], current: null, via: 'config_option', configId: 'model' }, modelId);
    return { ok: true, models: s.models.models, current: s.models.current };
  } catch (err) {
    return { ok: false, error: 'kiro_error', message: err instanceof Error ? err.message : String(err) };
  }
}

export function openKiroSessionCount(): number { return sessions.size; }
export function closeAllKiroSessions(): void { for (const id of [...sessions.keys()]) closeSession(id); }
