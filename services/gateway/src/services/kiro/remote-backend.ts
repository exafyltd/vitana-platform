/**
 * VTID-04999: the KiroBackend that runs `kiro-cli acp` on the private
 * kiro-runner service instead of in the gateway.
 *
 * spawn() opens a WebSocket to the runner for the signed-in user and thread
 * and adapts it to the AcpChild interface AcpClient already speaks, so
 * acp-client.ts and kiro-turn.ts run unchanged. One JSON-RPC message per text
 * frame. The runner sends one ready frame once kiro-cli is started; until then
 * a close is a start failure (4401 = this user has no linked key).
 *
 * The user's Kiro API key never passes through the gateway on a turn: the
 * runner reads it from Secrets Manager. The key routes below forward a key the
 * user typed straight to the runner and never log or return it.
 */
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { AcpChild, KiroRunnerInfo } from './acp-client';
import { isKiroMcpEnabled, mintKiroMcpToken } from './kiro-mcp-token';
import { KiroKeyMissingError, setKiroBackend, type KiroBackend, type KiroSpawnContext } from './kiro-turn';

export const RUNNER_READY_FRAME = JSON.stringify({ kiro_runner: 'ready' });
const MAX_FRAME_BYTES = 1024 * 1024;
const OPEN_TIMEOUT_MS = 20_000;

export { KiroKeyMissingError };

export interface RemoteBackendConfig { url: string; token: string }

function wsBase(url: string): string { return url.replace(/^http/, 'ws').replace(/\/+$/, ''); }

function startFailure(code: number, reason: string): Error {
  if (code === 4401) return new KiroKeyMissingError();
  return new Error(reason || `kiro-runner closed (${code})`);
}

/**
 * VTID-05064: apply a runner status frame ({"kiro_runner": ...}) to `info`. Returns true when
 * the frame was one (it is then kept out of the ACP stream), false for anything else.
 */
export function applyRunnerFrame(text: string, info: KiroRunnerInfo): boolean {
  if (!text.startsWith('{"kiro_runner"')) return false;
  let m: any;
  try { m = JSON.parse(text); } catch { return false; }
  if (!m || typeof m.kiro_runner !== 'string') return false;
  if (m.kiro_runner === 'workspace' && (m.state === 'restored' || m.state === 'fresh')) info.workspace = m.state;
  if (m.kiro_runner === 'workspace_state' && Array.isArray(m.dirty)) info.dirty = m.dirty.filter((x: unknown): x is string => typeof x === 'string').slice(0, 10);
  return true;
}

/** Wrap an open runner socket as the child process AcpClient expects. */
export function socketAsAcpChild(ws: WebSocket, runner: KiroRunnerInfo = { workspace: null, dirty: null }): AcpChild {
  const stdout = new EventEmitter();
  const proc = new EventEmitter();
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = String(data);
    if (applyRunnerFrame(text, runner)) return;
    stdout.emit('data', `${text}\n`);
  });
  ws.on('close', (code) => proc.emit('exit', code));
  ws.on('error', (err) => proc.emit('error', err));
  return {
    stdin: {
      write: (line: string) => {
        const frame = String(line).replace(/\n+$/, '');
        if (frame && ws.readyState === WebSocket.OPEN) ws.send(frame);
        return true;
      },
      end: () => { try { ws.close(1000); } catch { /* closing */ } },
    } as AcpChild['stdin'],
    stdout: stdout as unknown as AcpChild['stdout'],
    kill: () => { try { ws.close(1000); } catch { /* closing */ } },
    on: (event, cb) => proc.on(event, cb),
    runner,
  };
}

export function createRemoteKiroBackend(cfg: RemoteBackendConfig): KiroBackend {
  return {
    // The runner gives each session its own directory and rewrites cwd itself.
    workspace: () => '/work',
    spawn: (ctx: KiroSpawnContext) => new Promise<AcpChild>((resolve, reject) => {
      if (!ctx.userId) { reject(new KiroKeyMissingError()); return; }
      const q = new URLSearchParams({ user_id: ctx.userId, thread_id: ctx.threadId });
      // VTID-05005: the session's pass for the Operator's read tools, in a header (never the URL,
      // so it is in no access log). Without it the runner attaches no tools.
      const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
      const mcpToken = isKiroMcpEnabled() ? mintKiroMcpToken(ctx.userId, ctx.threadId) : null;
      if (mcpToken) headers['X-Kiro-Mcp-Token'] = mcpToken;
      const ws = new WebSocket(`${wsBase(cfg.url)}/sessions?${q.toString()}`, {
        headers,
        maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: OPEN_TIMEOUT_MS,
      });
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; ws.terminate(); reject(new Error('kiro-runner did not start Kiro in time')); } }, OPEN_TIMEOUT_MS);
      timer.unref?.();
      // VTID-05064: the runner's `workspace` frame comes before READY.
      const runner: KiroRunnerInfo = { workspace: null, dirty: null };
      const onFirst = (data: WebSocket.RawData) => {
        const text = String(data);
        if (text !== RUNNER_READY_FRAME) { applyRunnerFrame(text, runner); return; }
        settled = true;
        clearTimeout(timer);
        ws.off('message', onFirst);
        resolve(socketAsAcpChild(ws, runner));
      };
      ws.on('message', onFirst);
      ws.once('close', (code, reason) => { if (!settled) { settled = true; clearTimeout(timer); reject(startFailure(code, String(reason))); } });
      ws.once('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`kiro-runner unreachable: ${err.message}`)); } });
      ws.once('unexpected-response', (_req, res) => { if (!settled) { settled = true; clearTimeout(timer); ws.terminate(); reject(new Error(`kiro-runner refused the session (${res.statusCode})`)); } });
    }),
  };
}

export function runnerConfig(env: NodeJS.ProcessEnv = process.env): RemoteBackendConfig | null {
  const url = env.KIRO_RUNNER_URL ?? '';
  const token = env.KIRO_RUNNER_TOKEN ?? '';
  return url && token ? { url, token } : null;
}

/** Register the runner backend when the engine is on and the runner is configured. */
export function registerKiroBackendFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = runnerConfig(env);
  if (env.KIRO_ENGINE_ENABLED !== 'true' || !cfg) return false;
  setKiroBackend(createRemoteKiroBackend(cfg));
  return true;
}

export type KiroKeyStatus = { ok: true; linked: boolean; updated_at: string | null } | { ok: false; error: string; status: number };

/** Forward a key call to the runner. The user id comes from the caller's identity only. */
export async function kiroKeyRequest(
  method: 'GET' | 'PUT' | 'DELETE', userId: string, key?: string,
  env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000,
): Promise<KiroKeyStatus> {
  const cfg = runnerConfig(env);
  if (!cfg) return { ok: false, error: 'kiro_runner_not_configured', status: 503 };
  try {
    const res = await fetchImpl(`${cfg.url.replace(/\/+$/, '')}/keys/${encodeURIComponent(userId)}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: method === 'PUT' ? JSON.stringify({ key }) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok || body.ok !== true) {
      return { ok: false, error: typeof body.error === 'string' ? body.error : 'kiro_runner_error', status: res.status === 400 ? 400 : 502 };
    }
    return { ok: true, linked: body.linked === true, updated_at: typeof body.updated_at === 'string' ? body.updated_at : null };
  } catch {
    return { ok: false, error: 'kiro_runner_unreachable', status: 502 };
  }
}

/**
 * VTID-05003: is this user's Kiro key linked — for choosing the default engine.
 * 2 s runner timeout, answer cached per user for 60 s (cleared when the user
 * links or revokes). Unreachable / timeout / not configured => 'unknown'.
 */
const KEY_CACHE_MS = 60_000;
const keyCache = new Map<string, { linked: boolean; at: number }>();

export async function kiroKeyLinked(
  userId: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch, now: number = Date.now(),
): Promise<boolean | 'unknown'> {
  const hit = keyCache.get(userId);
  if (hit && now - hit.at < KEY_CACHE_MS) return hit.linked;
  const r = await kiroKeyRequest('GET', userId, undefined, env, fetchImpl, 2_000);
  if (!r.ok) return 'unknown';
  keyCache.set(userId, { linked: r.linked, at: now });
  return r.linked;
}

export function clearKiroKeyCache(userId?: string): void {
  if (userId) keyCache.delete(userId); else keyCache.clear();
}
