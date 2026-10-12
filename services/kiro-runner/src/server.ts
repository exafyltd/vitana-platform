/**
 * VTID-04999: kiro-runner HTTP + WebSocket server.
 *
 *   GET    /alive                        open; service + kiro-cli version
 *   GET    /keys/:userId                 { linked, updated_at } — never the key
 *   PUT    /keys/:userId   { key }       link or replace
 *   DELETE /keys/:userId                 revoke now; ends that user's sessions
 *   WS     /sessions?user_id=&thread_id= one kiro-cli acp process
 *   WS     /sessions/reattach?user_id=&thread_id=
 *                                        VTID-05068: take over a session whose
 *                                        gateway socket dropped; needs the
 *                                        session's X-Kiro-Reattach-Token.
 *                                        Refused: 4403 (token missing, wrong or
 *                                        expired), 4404 (no session for this
 *                                        user + thread).
 *
 * Everything but /alive needs `Authorization: Bearer <KIRO_RUNNER_TOKEN>`.
 * The service is private (Cloud Map only); the gateway is its only caller and
 * takes the user id from the signed-in identity. Request bodies are never logged.
 */
import http from 'http';
import { timingSafeEqual } from 'crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { KeyStore, KeyUnavailableError, isPlausibleKey, isUserId } from './key-store';
import { CLOSE, REATTACH_TOKEN_RE, detachedCount, sessionCount, sessionsOf, settleThread, startRelay, stopUserSessions, type RelayLimits, type RelayOptions } from './relay';
import { dropUserParked, type ParkLimits } from './workspace-park';
import type { RepoMirrors } from './repo-mirrors';

export interface RunnerConfig {
  token: string;
  workRoot: string;
  maxSessions: number;
  limits: RelayLimits;
  kiroCliVersion: string;
  kiroBin?: string;
  spawnImpl?: RelayOptions['spawnImpl'];
  /** VTID-05005: this environment's public gateway URL for the `vitana` tools (unset = no tools). */
  mcpGatewayUrl?: string;
  /** VTID-05006: shared repo mirrors (none = sessions start without the repos). */
  mirrors?: RepoMirrors | null;
  /** VTID-05064: keep workspaces with uncommitted work for the thread's next session (unset = remove at end). */
  park?: ParkLimits | null;
  log?: (msg: string) => void;
}

const MAX_BODY_BYTES = 16 * 1024;

export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!token || !header || !header.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

export function createRunnerServer(cfg: RunnerConfig, store: KeyStore): http.Server {
  const log = cfg.log ?? ((m: string) => console.log(m));
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.limits.maxLineBytes });
  let pending = 0; // sessions past the cap check whose key read is still in flight

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://kiro-runner');
    const done = (status: number, body: unknown) => { send(res, status, body); log(`[kiro-runner] ${req.method} ${url.pathname.replace(/\/keys\/.+/, '/keys/:userId')} ${status}`); };

    if (req.method === 'GET' && url.pathname === '/alive') {
      return done(200, { ok: true, service: 'kiro-runner', kiro_cli_version: cfg.kiroCliVersion, sessions: sessionCount(), detached: detachedCount() });
    }
    if (!tokenMatches(req.headers.authorization, cfg.token)) return done(401, { ok: false, error: 'unauthorized' });

    const m = /^\/keys\/([^/]+)$/.exec(url.pathname);
    if (!m) return done(404, { ok: false, error: 'not_found' });
    const userId = decodeURIComponent(m[1]);
    if (!isUserId(userId)) return done(400, { ok: false, error: 'invalid_user_id' });

    try {
      if (req.method === 'GET') return done(200, { ok: true, ...(await store.status(userId)) });
      if (req.method === 'PUT') {
        let body: any;
        try { body = await readJson(req); } catch { return done(400, { ok: false, error: 'invalid_body' }); }
        if (!isPlausibleKey(body?.key)) return done(400, { ok: false, error: 'invalid_key' });
        await store.put(userId, body.key);
        return done(200, { ok: true, ...(await store.status(userId)) });
      }
      if (req.method === 'DELETE') {
        await store.delete(userId);
        const ended = stopUserSessions(userId);
        dropUserParked(userId, log);
        return done(200, { ok: true, linked: false, updated_at: null, sessions_ended: ended });
      }
      return done(405, { ok: false, error: 'method_not_allowed' });
    } catch (err) {
      log(`[kiro-runner] key store error: ${(err as Error)?.name ?? 'error'}`);
      return done(502, { ok: false, error: 'key_store_unavailable' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://kiro-runner');
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== '/sessions' && url.pathname !== '/sessions/reattach') return reject(404, 'Not Found');
    if (!tokenMatches(req.headers.authorization, cfg.token)) return reject(401, 'Unauthorized');
    const userId = url.searchParams.get('user_id') ?? '';
    const threadId = url.searchParams.get('thread_id') ?? '';
    if (!isUserId(userId) || !threadId || threadId.length > 200) return reject(400, 'Bad Request');
    // VTID-05068: the session's reattach token, in a header (never the URL). Only its sha256 is kept.
    const rawReattach = req.headers['x-kiro-reattach-token'];
    const reattachToken = typeof rawReattach === 'string' && REATTACH_TOKEN_RE.test(rawReattach) ? rawReattach : '';

    if (url.pathname === '/sessions/reattach') {
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const candidates = sessionsOf(userId, threadId);
        if (candidates.length === 0) { ws.close(CLOSE.reattachNotFound, 'kiro_session_not_found'); log('[kiro-runner] reattach refused (no session)'); return; }
        const s = reattachToken ? candidates.find((c) => c.matches(reattachToken)) : undefined;
        if (!s) { ws.close(CLOSE.reattachRefused, 'kiro_reattach_refused'); log('[kiro-runner] reattach refused (token)'); return; }
        s.reattach(ws);
      });
      return;
    }

    // VTID-05005: the gateway-minted pass for the Operator's read tools. Opaque here; the gateway verifies it.
    const rawMcp = req.headers['x-kiro-mcp-token'];
    const mcpToken = typeof rawMcp === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(rawMcp) && rawMcp.length <= 2048 ? rawMcp : '';
    const mcp = cfg.mcpGatewayUrl && mcpToken ? { gatewayUrl: cfg.mcpGatewayUrl, token: mcpToken } : null;

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      // Reserve the slot before the key read, so concurrent connects cannot all pass the cap.
      if (sessionCount() + pending >= cfg.maxSessions) { ws.close(CLOSE.busy, 'kiro_runner_busy'); return; }
      pending++;
      void (async () => {
        try {
          let key: string | null;
          try { key = await store.get(userId); } catch (err) {
            log(`[kiro-runner] key read failed: ${err instanceof KeyUnavailableError ? err.message : 'error'}`);
            ws.close(CLOSE.keyUnavailable, 'kiro_key_unavailable');
            return;
          }
          if (!key) { ws.close(CLOSE.keyMissing, 'kiro_key_missing'); return; }
          // VTID-05068: a new session of this thread replaces its detached one, and gets its parked workspace.
          await settleThread(userId, threadId);
          if (ws.readyState !== ws.OPEN) return;
          startRelay({ ws, userId, threadId, key, mcp, mirrors: cfg.mirrors, park: cfg.park ?? null, workRoot: cfg.workRoot, limits: cfg.limits, kiroBin: cfg.kiroBin, spawnImpl: cfg.spawnImpl, log, reattachToken: reattachToken || null });
        } finally {
          pending--;
        }
      })();
    });
  });

  return server;
}
