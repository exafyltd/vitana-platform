/**
 * VTID-04999: one Operator thread's Kiro session — `kiro-cli acp` relayed over
 * a WebSocket, one JSON-RPC message per text frame in both directions.
 *
 * - The user's key goes into the child's environment and nowhere else. The
 *   child env is built from an allowlist, so the runner's own AWS credentials
 *   and token never reach Kiro.
 * - Each session gets a fresh empty directory, removed when it ends. The relay
 *   rewrites `cwd` in session/new and session/load, so the gateway cannot pick
 *   a path on this machine.
 * - Bounds of its own: idle and absolute timeouts, a ping, a line cap and a
 *   send-buffer cap. A slow or vanished gateway never makes the runner buffer
 *   without limit or keep a process alive.
 * - VTID-05068 (runs survive a gateway deploy): a session the gateway opened
 *   with a reattach token (`X-Kiro-Reattach-Token`, only its sha256 is kept
 *   here) that loses its socket while a prompt is running is DETACHED instead
 *   of ended: kiro-cli keeps working for `reattachMs` (KIRO_RUNNER_REATTACH_MS,
 *   default 10 min) and its output is buffered (cap `reattachBufferBytes`,
 *   2 MB; past it the session ends). A new socket for the same user + thread
 *   presenting the same token within the window takes the session over and
 *   gets, in order: one `reattached` status frame (the ACP session id and the
 *   prompt request ids still unanswered at the drop), the agent requests the
 *   old socket never answered, then the buffered frames. A close with 1000 /
 *   1005 (the gateway ended the session on purpose), a session without a
 *   token, or a drop between turns ends the session exactly as before.
 *   Refusals (server.ts): 4403 kiro_reattach_refused (missing / wrong /
 *   expired token), 4404 kiro_session_not_found (no such session for this
 *   user + thread). A socket replaced by a reattach closes 4409.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { WebSocket } from 'ws';
import type { RepoMirrors } from './repo-mirrors';
import { dirtyRepos, park, takeParked, type ParkLimits } from './workspace-park';

export const CLOSE = {
  normal: 1000,
  tooBig: 1009,
  kiroExited: 1011,
  keyUnavailable: 1011,
  keyMissing: 4401,
  idle: 4408,
  maxLifetime: 4410,
  busy: 4429,
  /** VTID-05068: reattach refused — token missing, wrong, or its window is over. */
  reattachRefused: 4403,
  /** VTID-05068: no session of this user + thread to reattach to. */
  reattachNotFound: 4404,
  /** VTID-05068: this socket was replaced by a reattach with the session's token. */
  takenOver: 4409,
} as const;

/** VTID-05068: how long a dropped session waits for its gateway, and how much it buffers meanwhile. */
export const REATTACH_DEFAULTS = { reattachMs: 10 * 60_000, reattachBufferBytes: 2 * 1024 * 1024 } as const;
/** VTID-05068: the token format the gateway mints (base64url of an HMAC-SHA256). */
export const REATTACH_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** The first frame the runner sends once Kiro is started: the gateway waits for it. */
export const READY_FRAME = JSON.stringify({ kiro_runner: 'ready' });
/**
 * VTID-05064: runner status frames, never JSON-RPC (no `jsonrpc`/`id`/`method`, so an
 * older gateway's ACP client ignores them). `workspace` comes BEFORE the READY frame
 * (an older gateway waits for READY and drops everything else until then);
 * `workspace_state` comes right before each session/prompt response.
 */
export const workspaceFrame = (state: 'restored' | 'fresh') => JSON.stringify({ kiro_runner: 'workspace', state });
export const workspaceStateFrame = (dirty: string[]) => JSON.stringify({ kiro_runner: 'workspace_state', dirty });
/**
 * VTID-05068: the first frame a reattached socket gets: the ACP session id, the session/prompt
 * request ids still unanswered when the old socket dropped (their answers may be in the replay),
 * and how many frames are replayed after this one.
 */
export const reattachedFrame = (sessionId: string | null, pendingPrompts: string[], replayed: number) =>
  JSON.stringify({ kiro_runner: 'reattached', session_id: sessionId, pending_prompts: pendingPrompts, replayed });

export interface RelayLimits {
  idleMs: number;
  maxSessionMs: number;
  pingMs: number;
  maxLineBytes: number;
  maxBufferedBytes: number;
  /** VTID-05068: how long a dropped session is kept for a reattach (0 = never, end at once as before). */
  reattachMs?: number;
  /** VTID-05068: output buffered while detached; past it the session ends. */
  reattachBufferBytes?: number;
}

export interface RelayOptions {
  ws: WebSocket;
  userId: string;
  threadId: string;
  key: string;
  /** VTID-05005: the session's pass for the Operator's read tools (none = no tools). */
  mcp?: McpConfig | null;
  /** VTID-05006: shared repo mirrors; each session gets its own worktrees (never blocks the start). */
  mirrors?: RepoMirrors | null;
  /** VTID-05064: keep a workspace with uncommitted work for the thread's next session (null = always remove). */
  park?: ParkLimits | null;
  workRoot: string;
  limits: RelayLimits;
  /** VTID-05068: the session's reattach token (only its sha256 is kept). None = the session ends when its socket drops. */
  reattachToken?: string | null;
  kiroBin?: string;
  spawnImpl?: typeof nodeSpawn;
  log?: (msg: string) => void;
}

export interface RelaySession {
  id: string; userId: string; threadId: string;
  stop(code: number, reason: string): void;
  /** VTID-05068: the socket dropped and the session waits for a reattach. */
  isDetached(): boolean;
  /** VTID-05068: does `token` reattach this session now (right token, inside the window)? */
  matches(token: string, now?: number): boolean;
  /** VTID-05068: hand the session to `ws` (call only after matches()). */
  reattach(ws: WebSocket): void;
  /** Resolves once the session has ended and its workspace was removed or parked. */
  done: Promise<void>;
}

const sessions = new Map<string, RelaySession>();
/** VTID-05068: sessions that ended and are still deciding whether to park (key: user + thread). */
const settling = new Map<string, Promise<void>>();
const threadKey = (userId: string, threadId: string) => `${userId}\u0000${threadId}`;
export function sessionCount(): number { return sessions.size; }
export function detachedCount(): number { return [...sessions.values()].filter((s) => s.isDetached()).length; }
/** VTID-05068: the live sessions of one user + thread (a reattach picks the one its token matches). */
export function sessionsOf(userId: string, threadId: string): RelaySession[] {
  return [...sessions.values()].filter((s) => s.userId === userId && s.threadId === threadId);
}
/**
 * VTID-05068: before a NEW session of a thread starts: end the thread's detached session (nobody
 * reattached it; a new session replaces it) and wait until any ended session of the thread has
 * parked its workspace, so the new session gets the parked edits instead of a fresh directory.
 */
export async function settleThread(userId: string, threadId: string): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const s of sessionsOf(userId, threadId)) if (s.isDetached()) { s.stop(CLOSE.normal, 'kiro_session_replaced'); waits.push(s.done); }
  const p = settling.get(threadKey(userId, threadId));
  if (p) waits.push(p);
  await Promise.all(waits);
}

/** VTID-05068: sha256 of a reattach token (what the session keeps). */
export function hashReattachToken(token: string): Buffer { return createHash('sha256').update(token, 'utf8').digest(); }
export function stopUserSessions(userId: string, code: number = CLOSE.normal, reason = 'kiro_key_revoked'): number {
  let n = 0;
  for (const s of [...sessions.values()]) if (s.userId === userId) { s.stop(code, reason); n++; }
  return n;
}
export function stopAllSessions(): void { for (const s of [...sessions.values()]) s.stop(CLOSE.normal, 'shutdown'); }

/** Allowlisted environment for kiro-cli. Nothing of the runner's own env leaks through. */
export function childEnv(key: string, dir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: base.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: base.LANG ?? 'C.UTF-8',
    HOME: dir,
    TMPDIR: path.join(dir, '.tmp'),
    KIRO_API_KEY: key,
  };
}

/** VTID-05005: where the `vitana` tools are and the session's pass for them. */
export interface McpConfig { gatewayUrl: string; token: string }

/** The relay program kiro-cli starts as the `vitana` stdio MCP server. */
export const MCP_PROXY_PATH = path.join(__dirname, 'mcp-proxy.js');

/**
 * VTID-05005: the MCP servers a session gets — decided here, never by the gateway.
 * Exactly the `vitana` relay when this session has a pass, otherwise none.
 */
export function mcpServersFor(mcp: McpConfig | null | undefined): unknown[] {
  if (!mcp || !mcp.gatewayUrl || !mcp.token) return [];
  return [{
    name: 'vitana',
    command: process.execPath,
    args: [MCP_PROXY_PATH],
    env: [
      { name: 'VITANA_MCP_URL', value: `${mcp.gatewayUrl.replace(/\/+$/, '')}/api/v1/operator/kiro/mcp` },
      { name: 'VITANA_MCP_TOKEN', value: mcp.token },
    ],
  }];
}

/**
 * session/new and session/load run in the session's own directory and with the
 * runner's own MCP server list, whatever the gateway asked for.
 */
export function rewriteCwd(line: string, dir: string, mcpServers: unknown[] = []): string {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return line; }
  if (msg && (msg.method === 'session/new' || msg.method === 'session/load') && msg.params && typeof msg.params === 'object') {
    msg.params.cwd = dir;
    msg.params.mcpServers = mcpServers;
    return JSON.stringify(msg);
  }
  return line;
}

/** VTID-05064: the JSON-RPC id of a session/prompt request, else null. */
export function promptRequestId(line: string): string | null {
  if (!line.includes('session/prompt')) return null;
  try { const m = JSON.parse(line); return m && m.method === 'session/prompt' && m.id !== undefined ? String(m.id) : null; } catch { return null; }
}

/** VTID-05064: the id of a JSON-RPC response (result or error, no method), else null. */
export function responseId(line: string): string | null {
  try { const m = JSON.parse(line); return m && !m.method && m.id !== undefined && ('result' in m || 'error' in m) ? String(m.id) : null; } catch { return null; }
}

export function startRelay(o: RelayOptions): RelaySession {
  const log = o.log ?? ((m: string) => console.log(m));
  const id = randomUUID();
  // VTID-05064: the thread's parked workspace (uncommitted edits from its last session), else a fresh one.
  const reused = o.park ? takeParked(o.userId, o.threadId) : null;
  const dir = reused ?? path.join(o.workRoot, id);
  fs.mkdirSync(path.join(dir, '.tmp'), { recursive: true, mode: 0o700 });

  const child: ChildProcess = (o.spawnImpl ?? nodeSpawn)(o.kiroBin ?? 'kiro-cli', ['acp'], {
    cwd: dir,
    env: childEnv(o.key, dir),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const servers = mcpServersFor(o.mcp);
  if (o.mirrors) void o.mirrors.addWorktrees(dir);
  let ended = false;
  let idle: NodeJS.Timeout | null = null;
  let alive = true;
  let buf = '';
  let firstNoise = true;
  // VTID-05064: ids of session/prompt requests; their responses are preceded by a workspace_state frame.
  const promptIds = new Set<string>();
  let outChain: Promise<void> = Promise.resolve();

  // VTID-05068: the socket can change (a reattach); kiro-cli's output goes to the CURRENT one,
  // or into the buffer while the session waits for its gateway.
  const reattachMs = o.limits.reattachMs ?? REATTACH_DEFAULTS.reattachMs;
  const bufferCap = o.limits.reattachBufferBytes ?? REATTACH_DEFAULTS.reattachBufferBytes;
  const tokenHash = o.reattachToken && reattachMs > 0 ? hashReattachToken(o.reattachToken) : null;
  let ws: WebSocket = o.ws;
  let attached = true;
  let detachedAt = 0;
  let detachTimer: NodeJS.Timeout | null = null;
  let pendingAtDrop: string[] = [];
  const buffered: string[] = [];
  let bufferedBytes = 0;
  let acpSessionId: string | null = null;
  const sessionRequestIds = new Set<string>();
  /** Agent → gateway requests (permission cards) not answered yet; `delivered` = a socket got them. */
  const openRequests = new Map<string, { line: string; delivered: boolean }>();

  let doneResolve!: () => void;
  const done = new Promise<void>((r) => { doneResolve = r; });

  const isOpen = (sock: WebSocket) => sock.readyState === sock.OPEN;
  /** VTID-05068: what a reattach needs from kiro-cli's output — its open requests and the ACP session id. */
  const noteOutgoing = (line: string) => {
    if (!tokenHash) return;
    if (line.includes('"method"')) {
      try { const m = JSON.parse(line); if (m && m.method && m.id !== undefined) openRequests.set(String(m.id), { line, delivered: false }); } catch { /* not JSON-RPC */ }
    }
    if (sessionRequestIds.size > 0 && line.includes('"sessionId"')) {
      try {
        const m = JSON.parse(line);
        if (m && !m.method && m.id !== undefined && sessionRequestIds.delete(String(m.id)) && typeof m.result?.sessionId === 'string') acpSessionId = m.result.sessionId;
      } catch { /* not JSON */ }
    }
  };
  const markDelivered = (line: string) => {
    if (openRequests.size === 0 || !line.includes('"method"')) return;
    for (const r of openRequests.values()) if (r.line === line) r.delivered = true;
  };
  /** Send to the current socket; while detached (or while the socket is going away) buffer it instead. */
  const deliver = (line: string) => {
    if (ended) return;
    if (attached && isOpen(ws)) { ws.send(line); markDelivered(line); return; }
    if (!tokenHash) return; // no reattach possible: dropped, as before
    buffered.push(line);
    bufferedBytes += Buffer.byteLength(line);
    if (bufferedBytes > bufferCap) end(CLOSE.tooBig, 'kiro_reattach_buffer_full');
  };
  const sendOut = (line: string) => { outChain = outChain.then(() => deliver(line)); };

  const end = (code: number, reason: string) => {
    if (ended) return;
    ended = true;
    sessions.delete(id);
    if (idle) clearTimeout(idle);
    if (detachTimer) clearTimeout(detachTimer);
    clearTimeout(lifetime);
    clearInterval(ping);
    buffered.length = 0;
    bufferedBytes = 0;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    hard.unref?.();
    try { if (attached && isOpen(ws)) ws.close(code, reason); } catch { /* closing */ }
    log(`[kiro-runner] session ${id} ended (${code} ${reason})`);
    // VTID-05064: uncommitted work survives the session (never on a revoked key).
    const keep = o.park && reason !== 'kiro_key_revoked' ? o.park : null;
    if (!keep) { fs.rm(dir, { recursive: true, force: true }, () => {}); doneResolve(); return; }
    const key = threadKey(o.userId, o.threadId);
    const parking: Promise<void> = dirtyRepos(dir).then((dirty) => {
      if (dirty.length === 0) { fs.rm(dir, { recursive: true, force: true }, () => {}); return; }
      park(dir, o.userId, o.threadId, keep, log);
      log(`[kiro-runner] session ${id} parked its workspace (uncommitted: ${dirty.join(', ')})`);
    }).catch(() => undefined).finally(() => { if (settling.get(key) === parking) settling.delete(key); doneResolve(); });
    settling.set(key, parking);
  };

  /**
   * VTID-05068: the current socket is gone. Kept for a reattach only when the session has a token,
   * a prompt is running, and the gateway did not end it on purpose (1000 / 1005); else ended as before.
   */
  const onSocketGone = (sock: WebSocket, code: number, reason: string) => {
    if (ended || sock !== ws || !attached) return;
    if (!tokenHash || code === 1000 || code === 1005 || promptIds.size === 0) { end(CLOSE.normal, reason); return; }
    attached = false;
    detachedAt = Date.now();
    pendingAtDrop = [...promptIds];
    detachTimer = setTimeout(() => end(CLOSE.normal, 'kiro_reattach_window_expired'), reattachMs);
    detachTimer.unref?.();
    log(`[kiro-runner] session ${id} detached (${code} ${reason}); kept ${Math.round(reattachMs / 1000)} s for a reattach`);
  };

  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => end(CLOSE.idle, 'kiro_session_idle'), o.limits.idleMs);
    idle.unref?.();
  };
  const lifetime = setTimeout(() => end(CLOSE.maxLifetime, 'kiro_session_max_lifetime'), o.limits.maxSessionMs);
  lifetime.unref?.();
  const ping = setInterval(() => {
    if (!attached) return; // VTID-05068: nothing to ping while detached
    if (!alive) { const sock = ws; onSocketGone(sock, 1006, 'gateway_gone'); try { sock.terminate(); } catch { /* gone */ } return; }
    alive = false;
    try { ws.ping(); } catch { onSocketGone(ws, 1006, 'gateway_gone'); }
  }, o.limits.pingMs);
  ping.unref?.();

  // Decode across chunk boundaries so a multi-byte character split between two chunks survives.
  const decoder = new StringDecoder('utf8');
  child.stdout?.on('data', (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > o.limits.maxLineBytes) { end(CLOSE.tooBig, 'kiro_line_too_long'); return; }
      if (line[0] !== '{') {
        // Kiro's own plain-text errors ("not logged in"). Keep the first one for the log; it carries no key.
        if (firstNoise) { firstNoise = false; log(`[kiro-runner] session ${id} kiro-cli said: ${line.slice(0, 200)}`); }
        continue;
      }
      if (attached && ws.bufferedAmount > o.limits.maxBufferedBytes) { end(CLOSE.tooBig, 'kiro_gateway_too_slow'); return; }
      touch();
      noteOutgoing(line);
      const promptId = promptIds.size > 0 ? responseId(line) : null;
      if (promptId !== null && promptIds.delete(promptId)) {
        // VTID-05064: tell the gateway, before the turn ends, whether this workspace holds unpushed edits.
        outChain = outChain.then(async () => {
          const dirty = await dirtyRepos(dir);
          deliver(workspaceStateFrame(dirty));
          deliver(line);
        });
      } else {
        sendOut(line);
      }
    }
    if (Buffer.byteLength(buf) > o.limits.maxLineBytes) end(CLOSE.tooBig, 'kiro_line_too_long');
  });
  child.stderr?.on('data', () => { /* kiro-cli logs to files; stderr is not relayed */ });
  child.on('error', (err) => { log(`[kiro-runner] session ${id} spawn error: ${err.message}`); end(CLOSE.kiroExited, 'kiro_exited'); });
  child.on('exit', (code) => end(CLOSE.kiroExited, `kiro_exited_${code ?? 'signal'}`));

  const wire = (sock: WebSocket) => {
    sock.on('pong', () => { if (sock === ws) alive = true; });
    sock.on('message', (data, isBinary) => {
      if (isBinary || ended || sock !== ws) return;
      touch();
      alive = true;
      const text = String(data);
      const pid = promptRequestId(text);
      if (pid !== null) promptIds.add(pid);
      if (tokenHash) {
        // VTID-05068: what a reattach needs — the ACP session id, and which agent requests got an answer.
        if (text.includes('session/new') || text.includes('session/load')) {
          try {
            const m = JSON.parse(text);
            if (m && (m.method === 'session/new' || m.method === 'session/load') && m.id !== undefined) sessionRequestIds.add(String(m.id));
            if (m && m.method === 'session/load' && typeof m.params?.sessionId === 'string') acpSessionId = m.params.sessionId;
          } catch { /* not JSON */ }
        }
        if (openRequests.size > 0) { const rid = responseId(text); if (rid !== null) openRequests.delete(rid); }
      }
      child.stdin?.write(`${rewriteCwd(text, dir, servers)}\n`);
    });
    sock.on('close', (code) => onSocketGone(sock, code, 'gateway_closed'));
    sock.on('error', () => onSocketGone(sock, 1006, 'gateway_error'));
  };
  wire(o.ws);

  const matches = (token: string, now: number = Date.now()): boolean => {
    if (ended || !tokenHash || typeof token !== 'string' || !REATTACH_TOKEN_RE.test(token)) return false;
    if (!attached && now - detachedAt > reattachMs) return false;
    return timingSafeEqual(hashReattachToken(token), tokenHash);
  };

  const reattach = (next: WebSocket) => {
    if (ended) { try { next.close(CLOSE.reattachNotFound, 'kiro_session_not_found'); } catch { /* closing */ } return; }
    const pending = attached ? [...promptIds] : pendingAtDrop;
    const old = ws;
    const wasAttached = attached;
    ws = next;
    attached = true;
    alive = true;
    if (detachTimer) { clearTimeout(detachTimer); detachTimer = null; }
    // A socket still attached (its gateway task has not noticed it is being replaced) is closed — not the session.
    if (wasAttached && old !== next) { try { old.close(CLOSE.takenOver, 'kiro_session_taken_over'); } catch { /* closing */ } }
    wire(next);
    const replay = [
      ...[...openRequests.values()].filter((r) => r.delivered).map((r) => r.line),
      ...buffered.splice(0),
    ];
    bufferedBytes = 0;
    next.send(reattachedFrame(acpSessionId, pending, replay.length));
    for (const line of replay) { next.send(line); markDelivered(line); }
    touch();
    log(`[kiro-runner] session ${id} reattached (${replay.length} frame(s) replayed)`);
  };

  const session: RelaySession = { id, userId: o.userId, threadId: o.threadId, stop: end, isDetached: () => !ended && !attached, matches, reattach, done };
  sessions.set(id, session);
  touch();
  o.ws.send(workspaceFrame(reused ? 'restored' : 'fresh'));
  o.ws.send(READY_FRAME);
  log(`[kiro-runner] session ${id} started for thread ${o.threadId.slice(0, 64)}${reused ? ' (parked workspace restored)' : ''}`);
  return session;
}

export function defaultWorkRoot(): string { return process.env.KIRO_RUNNER_WORK_ROOT || path.join(os.tmpdir(), 'kiro-work'); }
