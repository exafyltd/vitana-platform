/**
 * VTID-04358 — calendar step 7a: private iCalendar subscription feed.
 *
 * Pins the RFC 5545 output, the token model (hash-only storage, one shape,
 * rotation replaces), what leaves the platform (no descriptions, no alarms,
 * no work items), and the route wiring (feed open by token only, one answer
 * for every bad token, subscription endpoints behind sign-in).
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  buildIcs,
  icsEscape,
  icsFold,
  icsUtc,
  hashFeedToken,
  isWellFormedToken,
  newFeedToken,
  resolveFeedToken,
  rotateFeedToken,
  buildFeedForUser,
} from '../src/services/calendar-ics-feed';

describe('RFC 5545 formatting', () => {
  it('UTC timestamps', () => {
    expect(icsUtc('2026-09-23T08:05:09.123Z')).toBe('20260923T080509Z');
  });

  it('escapes TEXT', () => {
    expect(icsEscape('a,b;c\\d\nnext')).toBe('a\\,b\\;c\\\\d\\nnext');
  });

  it('folds at 75 octets without splitting a multi-byte character', () => {
    const line = 'SUMMARY:' + '🥗'.repeat(40);
    const folded = icsFold(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(parts[0], 'utf8')).toBeLessThanOrEqual(75);
    for (const p of parts.slice(1)) {
      expect(p.startsWith(' ')).toBe(true);
      expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
  });

  it('a calendar with one event, CRLF throughout, default length when no end', () => {
    const ics = buildIcs(
      [{ uid: 'e1@vitanaland', title: 'Bluttest, nüchtern', start: '2026-09-25T06:00:00Z', end: null, location: 'Labor; Raum 2', status: 'confirmed', updated: null }],
      new Date('2026-09-23T10:00:00Z'),
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(ics).toContain('DTSTART:20260925T060000Z');
    expect(ics).toContain('DTEND:20260925T063000Z');
    expect(ics).toContain('SUMMARY:Bluttest\\, nüchtern');
    expect(ics).toContain('LOCATION:Labor\\; Raum 2');
    expect(ics).toContain('DTSTAMP:20260923T100000Z');
  });

  it('never emits alarms or descriptions', () => {
    const ics = buildIcs([{ uid: 'u', title: 't', start: '2026-09-25T06:00:00Z', end: '2026-09-25T07:00:00Z', location: null, status: 'confirmed', updated: null }]);
    expect(ics).not.toContain('VALARM');
    expect(ics).not.toContain('DESCRIPTION');
  });

  it('pending becomes TENTATIVE; an unparseable start is skipped', () => {
    const ics = buildIcs([
      { uid: 'a', title: 'x', start: '2026-09-25T06:00:00Z', end: null, location: null, status: 'pending', updated: null },
      { uid: 'b', title: 'y', start: 'nope', end: null, location: null, status: 'confirmed', updated: null },
    ]);
    expect(ics).toContain('STATUS:TENTATIVE');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });
});

describe('tokens', () => {
  it('are 256-bit base64url, and only the SHA-256 hash is ever sent to storage', () => {
    const t = newFeedToken();
    expect(isWellFormedToken(t)).toBe(true);
    expect(hashFeedToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(newFeedToken()).not.toBe(t);
  });

  const realFetch = global.fetch;
  let calls: Array<{ url: string; method: string; body: any; headers: any }> = [];
  beforeEach(() => {
    calls = [];
    process.env.SUPABASE_URL = 'https://db.test';
    process.env.SUPABASE_SERVICE_ROLE = 'k';
  });
  afterAll(() => {
    global.fetch = realFetch;
  });
  const respond = (body: unknown, status = 200) => {
    global.fetch = jest.fn(async (url: any, init: any = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
      return new Response(JSON.stringify(body), { status });
    }) as any;
  };

  it('rotation upserts one row per user with the hash, never the token', async () => {
    respond(null, 201);
    const token = await rotateFeedToken('u1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('calendar_feed_tokens?on_conflict=user_id');
    expect(calls[0].headers.Prefer).toContain('resolution=merge-duplicates');
    expect(calls[0].body.token_hash).toBe(hashFeedToken(token));
    expect(JSON.stringify(calls[0].body)).not.toContain(token);
  });

  it('a malformed token never reaches the database', async () => {
    respond([]);
    expect(await resolveFeedToken('short')).toBeNull();
    expect(await resolveFeedToken('x'.repeat(43) + '/')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('a well-formed token is looked up by hash', async () => {
    respond([{ user_id: 'u9' }]);
    const t = newFeedToken();
    expect(await resolveFeedToken(t)).toBe('u9');
    expect(calls[0].url).toContain(`token_hash=eq.${hashFeedToken(t)}`);
    expect(calls[0].url).not.toContain(t);
  });

  it('the feed reads the user own rows with no lens filter and skips busy blocks', async () => {
    respond([]);
    await buildFeedForUser('u1', new Date('2026-09-23T10:00:00Z'));
    const reads = calls.filter((c) => c.url.includes('calendar_events'));
    expect(reads.length).toBe(2);
    for (const r of reads) {
      expect(r.url).toContain('user_id=eq.u1');
      expect(r.url).toContain('status=neq.cancelled');
    }
  });
});

describe('routes', () => {
  const emitted: any[] = [];
  function app(identity: any) {
    jest.resetModules();
    jest.doMock('../src/services/oasis-event-service', () => ({
      emitOasisEvent: jest.fn(async (e: any) => {
        emitted.push(e);
      }),
    }));
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      optionalAuth: (req: any, _res: any, next: any) => {
        if (identity) req.identity = identity;
        next();
      },
    }));
    jest.doMock('../src/services/calendar-ics-feed', () => ({
      resolveFeedToken: jest.fn(async (t: string) => (t === 'A'.repeat(43) ? 'u1' : null)),
      buildFeedForUser: jest.fn(async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
      rotateFeedToken: jest.fn(async () => 'B'.repeat(43)),
      revokeFeedToken: jest.fn(async () => undefined),
      getFeedStatus: jest.fn(async () => ({ active: true, created_at: 'x', last_used_at: null })),
    }));
    const router = require('../src/routes/calendar').default;
    const a = express();
    a.use(express.json());
    a.use('/api/v1/calendar', router);
    return a;
  }
  afterEach(() => {
    jest.dontMock('../src/middleware/auth-supabase-jwt');
    jest.dontMock('../src/services/calendar-ics-feed');
    jest.dontMock('../src/services/oasis-event-service');
  });

  it('the feed needs no bearer and serves text/calendar, private-cached', async () => {
    const res = await request(app(null)).get(`/api/v1/calendar/feed/${'A'.repeat(43)}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.headers['cache-control']).toBe('private, max-age=900');
    expect(res.text).toContain('BEGIN:VCALENDAR');
  });

  it('unknown, malformed and extension-less tokens all get the same 404', async () => {
    const a = app(null);
    for (const p of [`${'Z'.repeat(43)}.ics`, 'abc.ics', 'A'.repeat(43)]) {
      const res = await request(a).get(`/api/v1/calendar/feed/${p}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe('Not found');
    }
  });

  it('the subscription endpoints require sign-in', async () => {
    const a = app(null);
    expect((await request(a).get('/api/v1/calendar/subscription')).status).toBe(401);
    expect((await request(a).post('/api/v1/calendar/subscription')).status).toBe(401);
    expect((await request(a).delete('/api/v1/calendar/subscription')).status).toBe(401);
  });

  it('creating a link returns a path, never a hardcoded host', async () => {
    const res = await request(app({ user_id: 'u1' })).post('/api/v1/calendar/subscription');
    expect(res.status).toBe(201);
    expect(res.body.data.feed_path).toBe(`/api/v1/calendar/feed/${'B'.repeat(43)}.ics`);
  });

  it('creating and turning off a link emit OASIS events that never carry the token', async () => {
    emitted.length = 0;
    const a = app({ user_id: 'u1' });
    await request(a).post('/api/v1/calendar/subscription');
    await request(a).delete('/api/v1/calendar/subscription');
    expect(emitted.map((e) => e.type)).toEqual(['calendar.feed.link_created', 'calendar.feed.link_revoked']);
    expect(JSON.stringify(emitted)).not.toContain('B'.repeat(43));
  });

  it('other calendar routes stay behind sign-in', async () => {
    expect((await request(app(null)).get('/api/v1/calendar/events')).status).toBe(401);
  });
});

describe('migration', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../../../supabase/migrations/20260923170000_vtid_04358_calendar_feed_tokens.sql'),
    'utf8',
  );
  it('stores a hash only, one row per user, service role only', () => {
    expect(sql).toContain('user_id      uuid PRIMARY KEY');
    expect(sql).toContain("CHECK (token_hash ~ '^[0-9a-f]{64}$')");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('REVOKE ALL ON public.calendar_feed_tokens FROM PUBLIC, anon, authenticated');
    expect(sql).not.toMatch(/CREATE POLICY/);
  });
});
