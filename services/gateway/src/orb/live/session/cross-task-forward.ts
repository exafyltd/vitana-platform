/**
 * VTID-05002 — keep SSE ORB sessions alive while a gateway deploy runs two tasks.
 *
 * An SSE session lives in one task's in-process `liveSessions` Map. During a
 * rolling deploy the ALB round-robins every request between the old and the
 * new task, so about half of a session's audio POSTs land on the task that
 * does not hold it and get 404 `Session not found`; the widget re-registers
 * twice, then shows the network alert (orb-widget.js `_handleStaleSessionInstance`).
 *
 * Fix, behind `ORB_SSE_CROSS_TASK_FORWARD_ENABLED` (exact 'true', default off):
 *
 *  1. The owning task appends its own private `ip:port` to the session id,
 *     encrypted with AES-256-GCM (key from GATEWAY_INTERNAL_TOKEN via HKDF),
 *     so the client sees an opaque token it cannot read or forge.
 *  2. A task that receives a request for a session it does not hold, whose id
 *     carries a valid owner token for another private address, proxies that
 *     request once, task to task inside the VPC (not via the ALB), streaming
 *     the response through. Anything else — no token, a bad tag, a public or
 *     own address, a failed connection — falls through to today's 404.
 *
 * Forwards are task to task, so a draining old task still answers until it
 * stops; when it stops its sessions end with `server_shutdown` as today.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'crypto';
import * as http from 'http';
import type { NextFunction, Request, Response } from 'express';

export const FORWARD_FLAG = 'ORB_SSE_CROSS_TASK_FORWARD_ENABLED';
/** Set on a forwarded request; the receiving task never forwards it again. */
export const FORWARDED_HEADER = 'x-orb-forwarded-by';
/** Time to establish the task-to-task TCP connection. */
export const FORWARD_CONNECT_TIMEOUT_MS = 3000;

type Env = Record<string, string | undefined>;

export function isCrossTaskForwardEnabled(env: Env = process.env): boolean {
  return env[FORWARD_FLAG] === 'true' && !!env.GATEWAY_INTERNAL_TOKEN;
}

function ownerKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'vitana-orb-session-owner', 'v1', 32));
}

/** Encrypt `ip:port` into a base64url token (iv | tag | ciphertext). */
export function encodeOwner(address: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ownerKey(secret), iv);
  const ct = Buffer.concat([cipher.update(address, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

/** Decrypt an owner token; null for anything that does not authenticate. */
export function decodeOwner(token: string, secret: string): string | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < 12 + 16 + 3 || raw.length > 12 + 16 + 64) return null;
    const decipher = createDecipheriv('aes-256-gcm', ownerKey(secret), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const SESSION_ID_WITH_OWNER = /^live-[0-9a-f-]{36}\.([A-Za-z0-9_-]+)$/;

/** The owner token in a session id, or null for an id without one. */
export function ownerTokenOf(sessionId: string): string | null {
  const m = SESSION_ID_WITH_OWNER.exec(sessionId);
  return m ? m[1] : null;
}

/** RFC 1918 private IPv4 only — never loopback, link-local or public. */
export function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function parseAddress(address: string): { host: string; port: number } | null {
  const m = /^([0-9.]+):(\d{1,5})$/.exec(address);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}

// ---- this task's own address (ECS task metadata v4), cached once ---------

let selfAddressPromise: Promise<string | null> | null = null;
let selfAddressOverride: string | null | undefined;

/** Tests only: pin this process's own `ip:port` (null = unknown). */
export function __setSelfAddressForTests(address: string | null | undefined): void {
  selfAddressOverride = address;
  selfAddressPromise = null;
}

async function fetchSelfAddress(env: Env): Promise<string | null> {
  const base = env.ECS_CONTAINER_METADATA_URI_V4;
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const r = await fetch(`${base}/task`, { signal: controller.signal });
    if (!r.ok) return null;
    const task = (await r.json()) as { Containers?: Array<{ Networks?: Array<{ IPv4Addresses?: string[] }> }> };
    for (const c of task.Containers ?? []) {
      for (const n of c.Networks ?? []) {
        const ip = n.IPv4Addresses?.[0];
        if (ip && isPrivateIPv4(ip)) return `${ip}:${Number(env.PORT) || 8080}`;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveSelfAddress(env: Env = process.env): Promise<string | null> {
  if (selfAddressOverride !== undefined) return Promise.resolve(selfAddressOverride);
  if (!selfAddressPromise) {
    selfAddressPromise = fetchSelfAddress(env).then((a) => {
      // A failed lookup is retried on a later session start rather than cached.
      if (!a) selfAddressPromise = null;
      return a;
    });
  }
  return selfAddressPromise;
}

/**
 * New SSE session id. `live-<uuid>` exactly as before, plus `.<owner>` only
 * when the flag is on, the internal token is set and this task knows its
 * own address.
 */
export async function mintLiveSessionId(env: Env = process.env): Promise<string> {
  const base = `live-${randomUUID()}`;
  if (!isCrossTaskForwardEnabled(env)) return base;
  const self = await resolveSelfAddress(env);
  if (!self) return base;
  return `${base}.${encodeOwner(self, env.GATEWAY_INTERNAL_TOKEN as string)}`;
}

// ---- the forward ----------------------------------------------------------

export interface CrossTaskForwardOptions {
  /** True when this task holds the session. */
  hasSession: (sessionId: string) => boolean;
  /** Where this route carries the session id. */
  getSessionId: (req: Request) => string | undefined;
  /** Which hosts may be forwarded to. Default: RFC 1918 private IPv4. */
  allowTarget?: (host: string) => boolean;
  env?: Env;
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'host', 'content-length',
]);

/**
 * Express middleware for the SSE session routes. Calls next() whenever the
 * request is to be served locally (which yields today's behaviour, including
 * the 404 for an unknown session).
 */
export function createCrossTaskForward(opts: CrossTaskForwardOptions) {
  const allowTarget = opts.allowTarget ?? isPrivateIPv4;
  return async function orbSseCrossTaskForward(req: Request, res: Response, next: NextFunction) {
    const env = opts.env ?? process.env;
    if (!isCrossTaskForwardEnabled(env)) return next();
    if (req.get(FORWARDED_HEADER)) return next(); // one hop only
    const sessionId = opts.getSessionId(req);
    if (!sessionId || opts.hasSession(sessionId)) return next();
    const token = ownerTokenOf(sessionId);
    if (!token) return next();
    const owner = decodeOwner(token, env.GATEWAY_INTERNAL_TOKEN as string);
    const target = owner ? parseAddress(owner) : null;
    if (!target || !allowTarget(target.host)) {
      console.warn(`[orb-forward] VTID-05002 refused session=${sessionId.slice(0, 13)} reason=${owner ? 'target_not_allowed' : 'bad_owner_tag'}`);
      return next();
    }
    const self = await resolveSelfAddress(env);
    if (self && self === `${target.host}:${target.port}`) return next();
    forward(req, res, next, target, self, env.GATEWAY_INTERNAL_TOKEN as string, sessionId);
  };
}

function forward(
  req: Request,
  res: Response,
  next: NextFunction,
  target: { host: string; port: number },
  self: string | null,
  internalToken: string,
  sessionId: string,
): void {
  const started = Date.now();
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
  }
  headers[FORWARDED_HEADER] = self ?? 'unknown';
  headers['x-gateway-internal'] = internalToken;
  let body: Buffer | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
    body = Buffer.from(JSON.stringify(req.body), 'utf8');
    headers['content-type'] = 'application/json';
    headers['content-length'] = body.length;
  }

  let answered = false;
  const upstream = http.request({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.originalUrl,
    headers,
  });
  const fallBack = (why: string) => {
    if (answered || res.headersSent) return;
    answered = true;
    console.warn(`[orb-forward] VTID-05002 failed session=${sessionId.slice(0, 13)} to=${target.host} reason=${why} — serving locally`);
    upstream.destroy();
    next();
  };
  // Bounds only the TCP connect; once connected the owner answers at its own
  // pace (a /session/stop may finalize before responding).
  const connectTimer = setTimeout(() => fallBack('connect_timeout'), FORWARD_CONNECT_TIMEOUT_MS);
  upstream.on('socket', (socket) => {
    if (!socket.connecting) clearTimeout(connectTimer);
    else socket.once('connect', () => clearTimeout(connectTimer));
  });

  upstream.on('response', (upRes) => {
    clearTimeout(connectTimer);
    if (answered) { upRes.resume(); return; }
    answered = true;
    res.status(upRes.statusCode ?? 502);
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) res.setHeader(k, v);
    }
    res.setHeader('x-orb-served-by', 'forward');
    res.flushHeaders();
    upRes.pipe(res);
    upRes.on('end', () => {
      console.log(`[orb-forward] VTID-05002 ${req.method} ${req.path} session=${sessionId.slice(0, 13)} to=${target.host} status=${upRes.statusCode} ms=${Date.now() - started}`);
    });
  });
  upstream.on('error', (err) => {
    clearTimeout(connectTimer);
    if (!answered) fallBack(err.message);
    else res.end();
  });
  // The client went away (closed the EventSource, aborted the POST): drop the hop.
  res.on('close', () => upstream.destroy());
  upstream.end(body ?? undefined);
}
