/**
 * VTID-05023 part 6 (Aurora cutover, side-effects.md section B) — outbox sender.
 *
 * On Supabase two triggers call pg_net directly: notify_test_user_confirmation()
 * (test_user_applications) and notify_welcome_discount() (user_discount_codes).
 * Aurora has no pg_net, so on Aurora both functions INSERT one row into
 * public.outbound_http_requests (scripts/aws/aurora-cutover-outbox.sql) and this
 * worker sends it:
 *
 *   claim  — RPC outbound_http_claim: due rows, FOR UPDATE SKIP LOCKED, attempts+1,
 *            lease. Two gateway tasks never hold the same row.
 *   send   — fetch(url, {method, headers, body}) with a timeout.
 *   mark   — RPC outbound_http_complete (2xx) or outbound_http_fail (retry with
 *            exponential backoff, or final after OUTBOUND_HTTP_MAX_ATTEMPTS).
 *
 * Idempotent per row id: complete/fail only apply while the row is still held by
 * this exact attempt (id + attempts), a row marked sent is never claimed again,
 * and one tick never sends the same id twice. A crash between the HTTP response
 * and the mark re-sends that one row after the lease expires (at-least-once);
 * send-test-user-confirmation is idempotent itself (confirmation_sent_at).
 *
 * Secrets never live in a row. A secret header is stored as {"secret_ref": name}
 * and resolved here from an ALLOWLIST of names to this process's environment.
 * Secret values are never logged and are redacted from last_error. A row is only
 * sent to an https URL on an allowed origin (the public Supabase origin, plus
 * OUTBOUND_HTTP_ALLOWED_ORIGINS), so a secret can never be sent elsewhere.
 *
 * Ships inert: starts only with OUTBOUND_HTTP_WORKER_ENABLED=true, and never on
 * staging (staging shares the production database; it would send real emails).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabasePublicOrigin } from '../lib/supabase-public-url';

const LOG_PREFIX = '[outbound-http-worker]';

export const OUTBOUND_HTTP_MAX_ATTEMPTS = 5;
export const OUTBOUND_HTTP_TICK_MS = 30_000;
export const OUTBOUND_HTTP_BATCH = 10;
export const OUTBOUND_HTTP_LEASE_SECONDS = 120;
export const OUTBOUND_HTTP_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 3600;

export interface OutboundHttpRow {
  id: number | string;
  url: string;
  method: string;
  headers: Record<string, unknown> | null;
  body: unknown;
  attempts: number;
  status: string;
  source?: string | null;
}

export interface OutboundHttpLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface OutboundHttpDeps {
  supabase: Pick<SupabaseClient, 'rpc'>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  logger?: OutboundHttpLogger;
  batchSize?: number;
  timeoutMs?: number;
}

export interface OutboundHttpTickResult {
  ok: boolean;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  stale: number;
  error?: string;
}

/**
 * Secret header references a row may carry, and how each resolves. Unknown
 * names are rejected (never looked up in the environment by name).
 */
const SECRET_REFS: Record<string, (env: NodeJS.ProcessEnv) => string | undefined> = {
  // was vault 'email_trigger_secret' (X-Trigger-Secret for send-test-user-confirmation)
  email_trigger_secret: (env) => env.EMAIL_TRIGGER_SECRET || undefined,
  // was 'Bearer ' || vault 'service_role_key' (send-welcome-discount)
  supabase_service_role_bearer: (env) => {
    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE;
    return key ? `Bearer ${key}` : undefined;
  },
};

export const OUTBOUND_HTTP_SECRET_REFS: readonly string[] = Object.keys(SECRET_REFS);

/** A header that can never resolve (unknown ref, bad shape): the row fails for good. */
export class PermanentHeaderError extends Error {}
/** A known ref whose value is not configured yet: retried (config can be fixed). */
export class MissingSecretError extends Error {}

export function isOutboundHttpWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OUTBOUND_HTTP_WORKER_ENABLED === 'true' && env.VITANA_ENV !== 'staging';
}

/** Seconds to wait before the next try after failed attempt n (1-based): 30, 60, 120, 240 … capped at 1 h. */
export function backoffSeconds(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** (n - 1), BACKOFF_MAX_SECONDS);
}

/** Resolves stored headers to wire headers. Returns the secret values used, for redaction. */
export function resolveHeaders(
  stored: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { headers: Record<string, string>; secrets: string[] } {
  const headers: Record<string, string> = {};
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(stored ?? {})) {
    if (typeof value === 'string') {
      headers[name] = value;
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const ref = (value as Record<string, unknown>).secret_ref;
      if (typeof ref !== 'string') throw new PermanentHeaderError(`header ${name}: object without secret_ref`);
      const resolver = SECRET_REFS[ref];
      if (!resolver) throw new PermanentHeaderError(`header ${name}: unknown secret_ref "${ref}"`);
      const resolved = resolver(env);
      if (!resolved) throw new MissingSecretError(`header ${name}: secret_ref "${ref}" is not configured`);
      headers[name] = resolved;
      secrets.push(resolved);
      continue;
    }
    throw new PermanentHeaderError(`header ${name}: unsupported value type`);
  }
  return { headers, secrets };
}

/** https only, and only to the public Supabase origin or an explicitly allowed origin. */
export function isAllowedUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const allowed = new Set<string>();
  const pub = getSupabasePublicOrigin(env);
  if (pub) allowed.add(pub);
  for (const o of (env.OUTBOUND_HTTP_ALLOWED_ORIGINS || '').split(',')) {
    const t = o.trim();
    if (!t) continue;
    try {
      allowed.add(new URL(t).origin);
    } catch {
      /* ignore malformed entries */
    }
  }
  return allowed.has(parsed.origin);
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join('[redacted]');
    // also the bare token of a "Bearer <token>" value
    const bare = s.startsWith('Bearer ') ? s.slice(7) : '';
    if (bare) out = out.split(bare).join('[redacted]');
  }
  return out;
}

/** Path only (no query) for logs. */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

const defaultLogger: OutboundHttpLogger = {
  info: (m) => console.log(`${LOG_PREFIX} ${m}`),
  warn: (m) => console.warn(`${LOG_PREFIX} ${m}`),
};

type Outcome = { kind: 'sent' } | { kind: 'retry'; error: string } | { kind: 'final'; error: string };

async function sendRow(row: OutboundHttpRow, deps: OutboundHttpDeps): Promise<Outcome> {
  const env = deps.env ?? process.env;
  if (!isAllowedUrl(row.url, env)) return { kind: 'final', error: 'url not allowed (https + allowed origin only)' };
  const method = (row.method || 'POST').toUpperCase();

  let resolved: { headers: Record<string, string>; secrets: string[] };
  try {
    resolved = resolveHeaders(row.headers, env);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return e instanceof PermanentHeaderError ? { kind: 'final', error: msg } : { kind: 'retry', error: msg };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? OUTBOUND_HTTP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(row.url, {
      method,
      headers: resolved.headers,
      body: method === 'GET' || row.body == null ? undefined : JSON.stringify(row.body),
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) return { kind: 'sent' };
    let snippet = '';
    try {
      snippet = (await res.text()).slice(0, 300);
    } catch {
      /* body unreadable */
    }
    return { kind: 'retry', error: redact(`HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, resolved.secrets) };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { kind: 'retry', error: redact(msg, resolved.secrets) };
  } finally {
    clearTimeout(timer);
  }
}

/** One pass: claim a batch, send each row once, mark it. Never throws. */
export async function runOutboundHttpTick(deps: OutboundHttpDeps): Promise<OutboundHttpTickResult> {
  const log = deps.logger ?? defaultLogger;
  const result: OutboundHttpTickResult = { ok: true, claimed: 0, sent: 0, retried: 0, failed: 0, stale: 0 };

  const { data, error } = await deps.supabase.rpc('outbound_http_claim', {
    p_limit: deps.batchSize ?? OUTBOUND_HTTP_BATCH,
    p_lease_seconds: OUTBOUND_HTTP_LEASE_SECONDS,
    p_max_attempts: OUTBOUND_HTTP_MAX_ATTEMPTS,
  });
  if (error) {
    log.warn(`claim failed: ${error.message}`);
    return { ...result, ok: false, error: error.message };
  }
  const rows = (Array.isArray(data) ? data : []) as OutboundHttpRow[];
  result.claimed = rows.length;

  const seen = new Set<string>();
  for (const row of rows) {
    const key = String(row.id);
    if (seen.has(key)) continue; // never send the same id twice in one tick
    seen.add(key);

    const outcome = await sendRow(row, deps);
    const where = `row ${key} (${row.source ?? 'unknown'}) ${describeUrl(row.url)} attempt ${row.attempts}`;

    if (outcome.kind === 'sent') {
      const { data: done, error: e } = await deps.supabase.rpc('outbound_http_complete', {
        p_id: row.id,
        p_attempt: row.attempts,
      });
      if (e) {
        log.warn(`${where}: sent, but marking it sent failed (${e.message}) — it may be re-sent after the lease`);
        result.ok = false;
      } else if (done === false) {
        log.warn(`${where}: sent, but the row was no longer held by this attempt`);
        result.stale += 1;
      } else {
        result.sent += 1;
        log.info(`${where}: sent`);
      }
      continue;
    }

    const final = outcome.kind === 'final' || row.attempts >= OUTBOUND_HTTP_MAX_ATTEMPTS;
    const retryIn = final ? null : backoffSeconds(row.attempts);
    const { data: status, error: e } = await deps.supabase.rpc('outbound_http_fail', {
      p_id: row.id,
      p_attempt: row.attempts,
      p_error: outcome.error,
      p_retry_in_seconds: retryIn,
    });
    if (e) {
      log.warn(`${where}: ${outcome.error}; recording the failure failed (${e.message})`);
      result.ok = false;
    } else if (status == null) {
      result.stale += 1;
      log.warn(`${where}: ${outcome.error}; the row was no longer held by this attempt`);
    } else if (final) {
      result.failed += 1;
      log.warn(`${where}: FAILED for good — ${outcome.error}`);
    } else {
      result.retried += 1;
      log.warn(`${where}: ${outcome.error}; retry in ${retryIn}s`);
    }
  }
  return result;
}

let handle: NodeJS.Timeout | null = null;
let inFlight = false;

/** Starts the loop when enabled. Returns false (and does nothing) otherwise. */
export function startOutboundHttpWorker(
  getClient: () => Pick<SupabaseClient, 'rpc'> | null,
  opts: { env?: NodeJS.ProcessEnv; intervalMs?: number } = {},
): boolean {
  const env = opts.env ?? process.env;
  if (!isOutboundHttpWorkerEnabled(env) || handle) return false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const sb = getClient();
      if (!sb) {
        defaultLogger.warn('database client unavailable — skipping tick');
        return;
      }
      // Drain while full batches keep coming, bounded per tick.
      for (let i = 0; i < 10; i += 1) {
        const r = await runOutboundHttpTick({ supabase: sb, env });
        if (!r.ok || r.claimed < OUTBOUND_HTTP_BATCH) break;
      }
    } catch (e) {
      defaultLogger.warn(`tick failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight = false;
    }
  };
  handle = setInterval(tick, opts.intervalMs ?? OUTBOUND_HTTP_TICK_MS);
  handle.unref?.();
  void tick();
  return true;
}

/** Test hook. */
export function stopOutboundHttpWorker(): void {
  if (handle) clearInterval(handle);
  handle = null;
  inFlight = false;
}
