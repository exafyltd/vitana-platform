/**
 * VTID-05070: kiro-browser — the screenshot sidecar of the kiro-runner task.
 *
 * Listens on 127.0.0.1 only (shared localhost of the Fargate task; nothing in the VPC can
 * reach it). Three callers, three credentials:
 *
 *   GET    /alive                  open; browser status (ok, sandbox, error)
 *   POST   /sessions               runner only (KIRO_BROWSER_REGISTRY_TOKEN): {session_token, gateway_pass}
 *   DELETE /sessions               runner only: {session_token}
 *   POST   /screenshot             the `vitana-browser` relay (Bearer <session token>):
 *                                  {url, viewport?, full_page?, wait_for_selector?, click_selector?, sign_in?}
 *                                  → {ok, images: [{media_id, viewport, width, height, page_url, url}]}
 *
 * Bodies are never logged. Every screenshot goes through guard.ts and shooter.ts, and is
 * stored on the gateway (gateway.ts), which keeps the per-run cap.
 */
import http from 'http';
import { timingSafeEqual } from 'crypto';
import { checkTargetUrl } from './guard';
import { parseShotRequest, takeShot, ShotError, type BrowserLike, type ShotRequest } from './shooter';
import { GatewayClient, GatewayError, LIMIT_REACHED } from './gateway';

export interface BrowserStatus { ok: boolean; sandbox: boolean; error: string | null; chromium?: string }

export interface BrowserServerConfig {
  registryToken: string;
  gateway: GatewayClient;
  hosts: Set<string>;
  browser: () => BrowserLike | null;
  status: () => BrowserStatus;
  /** localStorage of the signed-in test user; null = sign-in not configured. */
  signIn?: (() => Promise<Record<string, string>>) | null;
  pageTimeoutMs?: number;
  maxSessions?: number;
  maxConcurrent?: number;
  sessionTtlMs?: number;
  log?: (m: string) => void;
  now?: () => number;
}

const MAX_BODY_BYTES = 16 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const PASS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

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

function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createBrowserServer(cfg: BrowserServerConfig): http.Server {
  const log = cfg.log ?? ((m: string) => console.log(m));
  const now = cfg.now ?? Date.now;
  const ttl = cfg.sessionTtlMs ?? 5 * 3_600_000;
  const maxSessions = cfg.maxSessions ?? 50;
  const maxConcurrent = cfg.maxConcurrent ?? 2;
  const sessions = new Map<string, { pass: string; at: number; busy: boolean }>();
  let running = 0;

  const sweep = () => { for (const [k, s] of sessions) if (now() - s.at > ttl) sessions.delete(k); };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://kiro-browser');
    const done = (status: number, body: unknown) => { send(res, status, body); log(`[kiro-browser] ${req.method} ${url.pathname} ${status}`); };

    if (req.method === 'GET' && url.pathname === '/alive') {
      return done(200, { ok: true, service: 'kiro-browser', browser: cfg.status(), sessions: sessions.size });
    }

    if (url.pathname === '/sessions') {
      if (!cfg.registryToken || !same(bearer(req), cfg.registryToken)) return done(401, { ok: false, error: 'unauthorized' });
      let body: any;
      try { body = await readJson(req); } catch { return done(400, { ok: false, error: 'invalid_body' }); }
      const token = typeof body?.session_token === 'string' && TOKEN.test(body.session_token) ? body.session_token : null;
      if (!token) return done(400, { ok: false, error: 'invalid_session_token' });
      if (req.method === 'DELETE') { sessions.delete(token); return done(200, { ok: true }); }
      if (req.method !== 'POST') return done(405, { ok: false, error: 'method_not_allowed' });
      const pass = typeof body?.gateway_pass === 'string' && PASS.test(body.gateway_pass) && body.gateway_pass.length <= 2048 ? body.gateway_pass : null;
      if (!pass) return done(400, { ok: false, error: 'invalid_gateway_pass' });
      sweep();
      if (!sessions.has(token) && sessions.size >= maxSessions) return done(429, { ok: false, error: 'too_many_sessions' });
      sessions.set(token, { pass, at: now(), busy: false });
      return done(200, { ok: true });
    }

    if (url.pathname === '/screenshot') {
      if (req.method !== 'POST') return done(405, { ok: false, error: 'method_not_allowed' });
      const s = sessions.get(bearer(req));
      if (!s) return done(401, { ok: false, error: 'unknown browser session' });
      let body: any;
      try { body = await readJson(req); } catch { return done(400, { ok: false, error: 'invalid arguments' }); }
      const parsed = parseShotRequest(body);
      if (!parsed.ok) return done(400, { ok: false, error: parsed.error });
      const target = checkTargetUrl(parsed.req.url, cfg.hosts);
      if (!target.ok) return done(400, { ok: false, error: target.error });
      const shot: ShotRequest = { ...parsed.req, url: target.url };
      const browser = cfg.browser();
      if (!browser) return done(503, { ok: false, error: `the browser is not available: ${cfg.status().error ?? 'not started'}` });
      if (s.busy) return done(429, { ok: false, error: 'a screenshot is already running for this session' });
      if (running >= maxConcurrent) return done(429, { ok: false, error: 'the browser is busy; try again in a moment' });
      s.busy = true;
      running++;
      try {
        const quota = await cfg.gateway.quota(s.pass);
        if (quota.remaining < shot.viewports.length) {
          const left = quota.remaining > 0 ? ` (${quota.remaining} left: ask for one viewport)` : '';
          return done(429, { ok: false, error: `${LIMIT_REACHED}${left}` });
        }
        let storage: Record<string, string> | null = null;
        if (shot.sign_in) {
          if (!cfg.signIn) return done(400, { ok: false, error: 'sign-in is not configured on this runner; take the screenshot signed out' });
          storage = await cfg.signIn();
        }
        const images: unknown[] = [];
        let blocked = 0;
        for (const vp of shot.viewports) {
          const taken = await takeShot(browser, shot, vp, { hosts: cfg.hosts, timeoutMs: cfg.pageTimeoutMs, storage });
          blocked += taken.blocked.length;
          const stored = await cfg.gateway.store(s.pass, taken.png, { viewport: vp, page_url: taken.page_url, width: taken.width, height: taken.height });
          images.push({ media_id: stored.media_id, run_id: stored.run_id, viewport: vp, width: taken.width, height: taken.height, page_url: taken.page_url, url: stored.url });
        }
        return done(200, { ok: true, images, blocked_requests: blocked });
      } catch (e) {
        const msg = e instanceof ShotError || e instanceof GatewayError ? e.message
          : e instanceof Error && e.message.startsWith('sign-in') ? e.message : 'screenshot failed';
        if (!(e instanceof ShotError || e instanceof GatewayError)) log(`[kiro-browser] screenshot error: ${e instanceof Error ? e.name : 'error'}`);
        return done(e instanceof GatewayError && msg.startsWith(LIMIT_REACHED) ? 429 : 422, { ok: false, error: msg });
      } finally {
        s.busy = false;
        running--;
      }
    }

    return done(404, { ok: false, error: 'not_found' });
  });
}
