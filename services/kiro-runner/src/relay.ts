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
 */
import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
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
} as const;

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

export interface RelayLimits {
  idleMs: number;
  maxSessionMs: number;
  pingMs: number;
  maxLineBytes: number;
  maxBufferedBytes: number;
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
  kiroBin?: string;
  spawnImpl?: typeof nodeSpawn;
  log?: (msg: string) => void;
}

export interface RelaySession { id: string; userId: string; threadId: string; stop(code: number, reason: string): void }

const sessions = new Map<string, RelaySession>();
export function sessionCount(): number { return sessions.size; }
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
  const sendOut = (line: string) => { outChain = outChain.then(() => { if (!ended && o.ws.readyState === o.ws.OPEN) o.ws.send(line); }); };

  const end = (code: number, reason: string) => {
    if (ended) return;
    ended = true;
    sessions.delete(id);
    if (idle) clearTimeout(idle);
    clearTimeout(lifetime);
    clearInterval(ping);
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const hard = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    hard.unref?.();
    try { if (o.ws.readyState === o.ws.OPEN) o.ws.close(code, reason); } catch { /* closing */ }
    log(`[kiro-runner] session ${id} ended (${code} ${reason})`);
    // VTID-05064: uncommitted work survives the session (never on a revoked key).
    const keep = o.park && reason !== 'kiro_key_revoked' ? o.park : null;
    if (!keep) { fs.rm(dir, { recursive: true, force: true }, () => {}); return; }
    void dirtyRepos(dir).then((dirty) => {
      if (dirty.length === 0) { fs.rm(dir, { recursive: true, force: true }, () => {}); return; }
      park(dir, o.userId, o.threadId, keep, log);
      log(`[kiro-runner] session ${id} parked its workspace (uncommitted: ${dirty.join(', ')})`);
    });
  };

  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => end(CLOSE.idle, 'kiro_session_idle'), o.limits.idleMs);
    idle.unref?.();
  };
  const lifetime = setTimeout(() => end(CLOSE.maxLifetime, 'kiro_session_max_lifetime'), o.limits.maxSessionMs);
  lifetime.unref?.();
  const ping = setInterval(() => {
    if (!alive) { end(CLOSE.normal, 'gateway_gone'); return; }
    alive = false;
    try { o.ws.ping(); } catch { end(CLOSE.normal, 'gateway_gone'); }
  }, o.limits.pingMs);
  ping.unref?.();
  o.ws.on('pong', () => { alive = true; });

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
      if (o.ws.bufferedAmount > o.limits.maxBufferedBytes) { end(CLOSE.tooBig, 'kiro_gateway_too_slow'); return; }
      touch();
      const promptId = promptIds.size > 0 ? responseId(line) : null;
      if (promptId !== null && promptIds.delete(promptId)) {
        // VTID-05064: tell the gateway, before the turn ends, whether this workspace holds unpushed edits.
        outChain = outChain.then(async () => {
          const dirty = await dirtyRepos(dir);
          if (!ended && o.ws.readyState === o.ws.OPEN) { o.ws.send(workspaceStateFrame(dirty)); o.ws.send(line); }
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

  o.ws.on('message', (data, isBinary) => {
    if (isBinary || ended) return;
    touch();
    alive = true;
    const text = String(data);
    const pid = promptRequestId(text);
    if (pid !== null) promptIds.add(pid);
    child.stdin?.write(`${rewriteCwd(text, dir, servers)}\n`);
  });
  o.ws.on('close', () => end(CLOSE.normal, 'gateway_closed'));
  o.ws.on('error', () => end(CLOSE.normal, 'gateway_error'));

  const session: RelaySession = { id, userId: o.userId, threadId: o.threadId, stop: end };
  sessions.set(id, session);
  touch();
  o.ws.send(workspaceFrame(reused ? 'restored' : 'fresh'));
  o.ws.send(READY_FRAME);
  log(`[kiro-runner] session ${id} started for thread ${o.threadId.slice(0, 64)}${reused ? ' (parked workspace restored)' : ''}`);
  return session;
}

export function defaultWorkRoot(): string { return process.env.KIRO_RUNNER_WORK_ROOT || path.join(os.tmpdir(), 'kiro-work'); }
