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
import type { AcpChild } from './acp-client';
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

/** Wrap an open runner socket as the child process AcpClient expects. */
export function socketAsAcpChild(ws: WebSocket): AcpChild {
  const stdout = new EventEmitter();
  const proc = new EventEmitter();
  ws.on('message', (data, isBinary) => { if (!isBinary) stdout.emit('data', `${String(data)}\n`); });
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
  };
}

export function createRemoteKiroBackend(cfg: RemoteBackendConfig): KiroBackend {
  return {
    // The runner gives each session its own directory and rewrites cwd itself.
    workspace: () => '/work',
    spawn: (ctx: KiroSpawnContext) => new Promise<AcpChild>((resolve, reject) => {
      if (!ctx.userId) { reject(new KiroKeyMissingError()); return; }
      const q = new URLSearchParams({ user_id: ctx.userId, thread_id: ctx.threadId });
      const ws = new WebSocket(`${wsBase(cfg.url)}/sessions?${q.toString()}`, {
        headers: { Authorization: `Bearer ${cfg.token}` },
        maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: OPEN_TIMEOUT_MS,
      });
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; ws.terminate(); reject(new Error('kiro-runner did not start Kiro in time')); } }, OPEN_TIMEOUT_MS);
      timer.unref?.();
      const onFirst = (data: WebSocket.RawData) => {
        if (String(data) !== RUNNER_READY_FRAME) return;
        settled = true;
        clearTimeout(timer);
        ws.off('message', onFirst);
        resolve(socketAsAcpChild(ws));
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
  env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch,
): Promise<KiroKeyStatus> {
  const cfg = runnerConfig(env);
  if (!cfg) return { ok: false, error: 'kiro_runner_not_configured', status: 503 };
  try {
    const res = await fetchImpl(`${cfg.url.replace(/\/+$/, '')}/keys/${encodeURIComponent(userId)}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: method === 'PUT' ? JSON.stringify({ key }) : undefined,
      signal: AbortSignal.timeout(10_000),
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
