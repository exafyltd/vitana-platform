// VTID-05023 part 6 — outbox sender for the two pg_net triggers (side-effects.md B).
//
// The worker claims rows through outbound_http_claim, sends each once, and marks it
// with outbound_http_complete / outbound_http_fail (backoff, final after 5 attempts).
// Header secrets are references resolved from an allowlist; values never reach a log
// or last_error. Only https URLs on an allowed origin are sent. Inert by default.
import {
  runOutboundHttpTick,
  resolveHeaders,
  isAllowedUrl,
  backoffSeconds,
  isOutboundHttpWorkerEnabled,
  startOutboundHttpWorker,
  stopOutboundHttpWorker,
  PermanentHeaderError,
  MissingSecretError,
  OUTBOUND_HTTP_MAX_ATTEMPTS,
  type OutboundHttpRow,
} from '../src/services/outbound-http-worker';

const BASE = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
const SERVICE_KEY = 'service-role-jwt-SECRET-abc123';
const TRIGGER_SECRET = 'trigger-secret-XYZ-987';
const ENV: NodeJS.ProcessEnv = {
  SUPABASE_URL: BASE,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  EMAIL_TRIGGER_SECRET: TRIGGER_SECRET,
};

type Row = OutboundHttpRow & { last_error?: string | null; retry_in?: number | null; sent_at?: string | null };

/** In-memory model of the three RPCs in scripts/aws/aurora-cutover-outbox.sql. */
function fakeDb(rows: Row[], opts: { duplicate?: boolean; completeReturns?: boolean } = {}) {
  const calls: Array<{ fn: string; args: any }> = [];
  const rpc = jest.fn(async (fn: string, args: any) => {
    calls.push({ fn, args });
    if (fn === 'outbound_http_claim') {
      const due = rows
        .filter((r) => r.status === 'pending' && r.attempts < args.p_max_attempts)
        .slice(0, args.p_limit);
      for (const r of due) {
        r.status = 'sending';
        r.attempts += 1;
      }
      const out = due.map((r) => ({ ...r }));
      return { data: opts.duplicate ? [...out, ...out] : out, error: null };
    }
    const r = rows.find((x) => String(x.id) === String(args.p_id));
    const held = !!r && r.status === 'sending' && r.attempts === args.p_attempt;
    if (fn === 'outbound_http_complete') {
      if (opts.completeReturns === false) return { data: false, error: null };
      if (!held) return { data: false, error: null };
      r!.status = 'sent';
      r!.sent_at = 'now';
      return { data: true, error: null };
    }
    if (fn === 'outbound_http_fail') {
      if (!held) return { data: null, error: null };
      r!.status = args.p_retry_in_seconds == null ? 'failed' : 'pending';
      r!.last_error = args.p_error;
      r!.retry_in = args.p_retry_in_seconds;
      return { data: r!.status, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  });
  return { supabase: { rpc } as any, calls, rpc };
}

function welcomeRow(over: Partial<Row> = {}): Row {
  return {
    id: 1,
    url: `${BASE}/functions/v1/send-welcome-discount`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: { secret_ref: 'supabase_service_role_bearer' } },
    body: { discount_code_id: 'd1', user_id: 'u1', code: 'MAXINA-ABC123', discount_percent: 10, expires_at: '2027-01-01T00:00:00Z' },
    attempts: 0,
    status: 'pending',
    source: 'notify_welcome_discount',
    ...over,
  };
}

function testUserRow(over: Partial<Row> = {}): Row {
  return {
    id: 2,
    url: `${BASE}/functions/v1/send-test-user-confirmation`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Trigger-Secret': { secret_ref: 'email_trigger_secret' } },
    body: { application_id: 'a1' },
    attempts: 0,
    status: 'pending',
    source: 'notify_test_user_confirmation',
    ...over,
  };
}

function okFetch(status = 200) {
  return jest.fn(async (_url: any, _init?: any) => ({ status, text: async () => 'body' }) as any);
}

function captureLogger() {
  const lines: string[] = [];
  return { lines, logger: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) } };
}

afterEach(() => stopOutboundHttpWorker());

describe('claim → send → mark sent', () => {
  it('sends the welcome-discount row with the resolved Authorization header and the exact body', async () => {
    const rows = [welcomeRow()];
    const db = fakeDb(rows);
    const fetchImpl = okFetch();
    const r = await runOutboundHttpTick({ supabase: db.supabase, fetchImpl, env: ENV, logger: captureLogger().logger });

    expect(db.calls[0]).toEqual({
      fn: 'outbound_http_claim',
      args: { p_limit: 10, p_lease_seconds: 120, p_max_attempts: OUTBOUND_HTTP_MAX_ATTEMPTS },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/functions/v1/send-welcome-discount`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_KEY}` });
    expect(JSON.parse(init.body)).toEqual(rows[0].body);
    expect(db.calls[1]).toEqual({ fn: 'outbound_http_complete', args: { p_id: 1, p_attempt: 1 } });
    expect(rows[0].status).toBe('sent');
    expect(r).toMatchObject({ ok: true, claimed: 1, sent: 1, retried: 0, failed: 0 });
  });

  it('sends the test-user confirmation with X-Trigger-Secret resolved from EMAIL_TRIGGER_SECRET', async () => {
    const rows = [testUserRow()];
    const fetchImpl = okFetch(204);
    await runOutboundHttpTick({ supabase: fakeDb(rows).supabase, fetchImpl, env: ENV, logger: captureLogger().logger });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Trigger-Secret': TRIGGER_SECRET });
    expect(JSON.parse(init.body)).toEqual({ application_id: 'a1' });
    expect(rows[0].status).toBe('sent');
  });

  it('an empty claim does nothing', async () => {
    const fetchImpl = okFetch();
    const r = await runOutboundHttpTick({ supabase: fakeDb([]).supabase, fetchImpl, env: ENV });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, claimed: 0 });
  });

  it('a claim error is reported, nothing is sent', async () => {
    const supabase = { rpc: jest.fn(async () => ({ data: null, error: { message: 'boom' } })) } as any;
    const fetchImpl = okFetch();
    const r = await runOutboundHttpTick({ supabase, fetchImpl, env: ENV, logger: captureLogger().logger });
    expect(r).toMatchObject({ ok: false, error: 'boom' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('retry with backoff, final after 5 attempts', () => {
  it('backoff doubles from 30 s and caps at 1 h', () => {
    expect([1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([30, 60, 120, 240, 480]);
    expect(backoffSeconds(20)).toBe(3600);
  });

  it('a 500 goes back to pending with the backoff for that attempt', async () => {
    const rows = [welcomeRow({ attempts: 2 })];
    const db = fakeDb(rows);
    const r = await runOutboundHttpTick({ supabase: db.supabase, fetchImpl: okFetch(500), env: ENV, logger: captureLogger().logger });
    const fail = db.calls.find((c) => c.fn === 'outbound_http_fail')!;
    expect(fail.args).toMatchObject({ p_id: 1, p_attempt: 3, p_retry_in_seconds: 120 });
    expect(fail.args.p_error).toMatch(/^HTTP 500/);
    expect(rows[0].status).toBe('pending');
    expect(r).toMatchObject({ retried: 1, failed: 0 });
  });

  it('a network error is retried', async () => {
    const rows = [welcomeRow()];
    const fetchImpl = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await runOutboundHttpTick({ supabase: fakeDb(rows).supabase, fetchImpl: fetchImpl as any, env: ENV, logger: captureLogger().logger });
    expect(rows[0]).toMatchObject({ status: 'pending', retry_in: 30 });
    expect(rows[0].last_error).toContain('ECONNRESET');
  });

  it('the 5th failed attempt is final (status failed, no retry)', async () => {
    const rows = [welcomeRow({ attempts: OUTBOUND_HTTP_MAX_ATTEMPTS - 1 })];
    const r = await runOutboundHttpTick({ supabase: fakeDb(rows).supabase, fetchImpl: okFetch(503), env: ENV, logger: captureLogger().logger });
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 5, retry_in: null });
    expect(r).toMatchObject({ failed: 1, retried: 0 });
  });

  it('five failing ticks end in failed, and the row is never claimed again', async () => {
    const rows = [welcomeRow()];
    const db = fakeDb(rows);
    const fetchImpl = okFetch(500);
    for (let i = 0; i < 7; i += 1) {
      await runOutboundHttpTick({ supabase: db.supabase, fetchImpl, env: ENV, logger: captureLogger().logger });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 5 });
  });
});

describe('idempotency per row id', () => {
  it('a row id returned twice in one claim is sent once', async () => {
    const rows = [welcomeRow()];
    const fetchImpl = okFetch();
    await runOutboundHttpTick({ supabase: fakeDb(rows, { duplicate: true }).supabase, fetchImpl, env: ENV, logger: captureLogger().logger });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a sent row is not sent again on the next tick', async () => {
    const rows = [welcomeRow()];
    const db = fakeDb(rows);
    const fetchImpl = okFetch();
    await runOutboundHttpTick({ supabase: db.supabase, fetchImpl, env: ENV, logger: captureLogger().logger });
    await runOutboundHttpTick({ supabase: db.supabase, fetchImpl, env: ENV, logger: captureLogger().logger });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a completion that no longer holds the row (lease taken over) is counted stale, not sent', async () => {
    const rows = [welcomeRow()];
    const { lines, logger } = captureLogger();
    const r = await runOutboundHttpTick({ supabase: fakeDb(rows, { completeReturns: false }).supabase, fetchImpl: okFetch(), env: ENV, logger });
    expect(r).toMatchObject({ sent: 0, stale: 1 });
    expect(lines.join('\n')).toMatch(/no longer held/);
  });
});

describe('header references', () => {
  it('plain strings pass through; refs resolve from the allowlist', () => {
    const out = resolveHeaders(
      { 'Content-Type': 'application/json', Authorization: { secret_ref: 'supabase_service_role_bearer' } },
      ENV,
    );
    expect(out.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_KEY}` });
    expect(out.secrets).toEqual([`Bearer ${SERVICE_KEY}`]);
  });

  it('falls back to SUPABASE_SERVICE_ROLE', () => {
    const out = resolveHeaders({ A: { secret_ref: 'supabase_service_role_bearer' } }, { SUPABASE_SERVICE_ROLE: 'k2' });
    expect(out.headers.A).toBe('Bearer k2');
  });

  it('an unknown ref is permanent and never looked up in the environment by name', () => {
    expect(() => resolveHeaders({ A: { secret_ref: 'PATH' } }, { PATH: '/usr/bin' })).toThrow(PermanentHeaderError);
    expect(() => resolveHeaders({ A: { nope: 1 } }, ENV)).toThrow(PermanentHeaderError);
    expect(() => resolveHeaders({ A: 5 as any }, ENV)).toThrow(PermanentHeaderError);
  });

  it('a known but unconfigured ref is retryable', () => {
    expect(() => resolveHeaders({ A: { secret_ref: 'email_trigger_secret' } }, {})).toThrow(MissingSecretError);
  });

  it('unknown ref → row failed for good, nothing sent; missing secret → retried, nothing sent', async () => {
    const rows = [welcomeRow({ id: 1, headers: { A: { secret_ref: 'aws_secret' } } }), testUserRow({ id: 2 })];
    const fetchImpl = okFetch();
    await runOutboundHttpTick({
      supabase: fakeDb(rows).supabase,
      fetchImpl,
      env: { SUPABASE_URL: BASE },
      logger: captureLogger().logger,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: 'failed' });
    expect(rows[0].last_error).toMatch(/unknown secret_ref "aws_secret"/);
    expect(rows[1]).toMatchObject({ status: 'pending', retry_in: 30 });
    expect(rows[1].last_error).toMatch(/email_trigger_secret" is not configured/);
  });
});

describe('only allowed destinations', () => {
  it('https on the public Supabase origin, or an explicitly allowed origin', () => {
    expect(isAllowedUrl(`${BASE}/functions/v1/x`, ENV)).toBe(true);
    expect(isAllowedUrl(`${BASE}/functions/v1/x`, { SUPABASE_URL: 'http://proxy.internal:8080', SUPABASE_PUBLIC_URL: BASE })).toBe(true);
    expect(isAllowedUrl('http://inmkhvwdcuyhnxkgfvsb.supabase.co/functions/v1/x', ENV)).toBe(false);
    expect(isAllowedUrl('https://evil.example.com/x', ENV)).toBe(false);
    expect(isAllowedUrl('https://hooks.example.com/x', { ...ENV, OUTBOUND_HTTP_ALLOWED_ORIGINS: 'https://hooks.example.com' })).toBe(true);
    expect(isAllowedUrl('not a url', ENV)).toBe(false);
  });

  it('a row for another host is failed without sending its secret header', async () => {
    const rows = [welcomeRow({ url: 'https://evil.example.com/steal' })];
    const fetchImpl = okFetch();
    await runOutboundHttpTick({ supabase: fakeDb(rows).supabase, fetchImpl, env: ENV, logger: captureLogger().logger });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows[0].status).toBe('failed');
  });
});

describe('no secret in logs or last_error', () => {
  it('error text echoing the secret is redacted everywhere', async () => {
    const rows = [welcomeRow({ id: 1 }), testUserRow({ id: 2 })];
    const fetchImpl = jest.fn(async (_u: any, init: any) => {
      throw new Error(`upstream rejected ${JSON.stringify(init.headers)}`);
    });
    const { lines, logger } = captureLogger();
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const spyW = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runOutboundHttpTick({ supabase: fakeDb(rows).supabase, fetchImpl: fetchImpl as any, env: ENV, logger });
    const everything = [
      ...lines,
      ...rows.map((r) => r.last_error ?? ''),
      ...spy.mock.calls.flat().map(String),
      ...spyW.mock.calls.flat().map(String),
    ].join('\n');
    spy.mockRestore();
    spyW.mockRestore();
    expect(everything).not.toContain(SERVICE_KEY);
    expect(everything).not.toContain(TRIGGER_SECRET);
    expect(rows[0].last_error).toContain('[redacted]');
  });

  it('a non-2xx response body echoing the secret is redacted', async () => {
    const rows = [welcomeRow()];
    const fetchImpl = jest.fn(async () => ({ status: 401, text: async () => `bad token ${SERVICE_KEY}` }) as any);
    const { lines, logger } = captureLogger();
    await runOutboundHttpTick({ supabase: fakeDb(rows).supabase, fetchImpl, env: ENV, logger });
    expect(rows[0].last_error).toBe('HTTP 401: bad token [redacted]');
    expect(lines.join('\n')).not.toContain(SERVICE_KEY);
  });

  it('success logs carry the row id and path, never header values', async () => {
    const rows = [testUserRow()];
    const { lines, logger } = captureLogger();
    await runOutboundHttpTick({ supabase: fakeDb(rows).supabase, fetchImpl: okFetch(), env: ENV, logger });
    expect(lines).toEqual([`row 2 (notify_test_user_confirmation) ${BASE}/functions/v1/send-test-user-confirmation attempt 1: sent`]);
  });
});

describe('inert by default', () => {
  it('enabled only with OUTBOUND_HTTP_WORKER_ENABLED=true, never on staging', () => {
    expect(isOutboundHttpWorkerEnabled({})).toBe(false);
    expect(isOutboundHttpWorkerEnabled({ OUTBOUND_HTTP_WORKER_ENABLED: '1' })).toBe(false);
    expect(isOutboundHttpWorkerEnabled({ OUTBOUND_HTTP_WORKER_ENABLED: 'true' })).toBe(true);
    expect(isOutboundHttpWorkerEnabled({ OUTBOUND_HTTP_WORKER_ENABLED: 'true', VITANA_ENV: 'staging' })).toBe(false);
  });

  it('start does nothing when disabled', () => {
    const getClient = jest.fn();
    expect(startOutboundHttpWorker(getClient, { env: {} })).toBe(false);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('start runs a first tick when enabled', async () => {
    const db = fakeDb([]);
    expect(startOutboundHttpWorker(() => db.supabase, { env: { OUTBOUND_HTTP_WORKER_ENABLED: 'true' }, intervalMs: 60_000 })).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(db.rpc).toHaveBeenCalledWith('outbound_http_claim', expect.any(Object));
  });
});
