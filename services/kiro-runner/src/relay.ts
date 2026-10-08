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
import type { WebSocket } from 'ws';

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

/** session/new and session/load run in the session's own directory, whatever the gateway asked for. */
export function rewriteCwd(line: string, dir: string): string {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return line; }
  if (msg && (msg.method === 'session/new' || msg.method === 'session/load') && msg.params && typeof msg.params === 'object') {
    msg.params.cwd = dir;
    return JSON.stringify(msg);
  }
  return line;
}

export function startRelay(o: RelayOptions): RelaySession {
  const log = o.log ?? ((m: string) => console.log(m));
  const id = randomUUID();
  const dir = path.join(o.workRoot, id);
  fs.mkdirSync(path.join(dir, '.tmp'), { recursive: true, mode: 0o700 });

  const child: ChildProcess = (o.spawnImpl ?? nodeSpawn)(o.kiroBin ?? 'kiro-cli', ['acp'], {
    cwd: dir,
    env: childEnv(o.key, dir),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let ended = false;
  let idle: NodeJS.Timeout | null = null;
  let alive = true;
  let buf = '';
  let firstNoise = true;

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
    fs.rm(dir, { recursive: true, force: true }, () => {});
    log(`[kiro-runner] session ${id} ended (${code} ${reason})`);
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

  child.stdout?.on('data', (chunk: Buffer | string) => {
    buf += String(chunk);
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (line[0] !== '{') {
        // Kiro's own plain-text errors ("not logged in"). Keep the first one for the log; it carries no key.
        if (firstNoise) { firstNoise = false; log(`[kiro-runner] session ${id} kiro-cli said: ${line.slice(0, 200)}`); }
        continue;
      }
      if (o.ws.bufferedAmount > o.limits.maxBufferedBytes) { end(CLOSE.tooBig, 'kiro_gateway_too_slow'); return; }
      touch();
      o.ws.send(line);
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
    child.stdin?.write(`${rewriteCwd(String(data), dir)}\n`);
  });
  o.ws.on('close', () => end(CLOSE.normal, 'gateway_closed'));
  o.ws.on('error', () => end(CLOSE.normal, 'gateway_error'));

  const session: RelaySession = { id, userId: o.userId, threadId: o.threadId, stop: end };
  sessions.set(id, session);
  touch();
  o.ws.send(READY_FRAME);
  log(`[kiro-runner] session ${id} started for thread ${o.threadId.slice(0, 64)}`);
  return session;
}

export function defaultWorkRoot(): string { return process.env.KIRO_RUNNER_WORK_ROOT || path.join(os.tmpdir(), 'kiro-work'); }
