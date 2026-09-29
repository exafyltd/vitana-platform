// VTID-04733 — POST /api/v1/scheduled-notifications/whats-new
//
// Contract: reads the production frontend's /whats-new.json, publishes the
// oldest fresh unpublished entry as a tenant-wide 'brand-new-feature' card,
// fans out per-locale, records the entry id in created_by (dedupe), and never
// publishes more than one per gap, anything stale, or anything twice.

import express from 'express';
import request from 'supertest';
import {
  parseWhatsNewManifest,
  selectNextWhatsNewEntry,
  WHATS_NEW_CREATED_BY_PREFIX,
} from '../src/services/whats-new-publisher';

let mockSupabase: any;
const notifyUserMock = jest.fn();
const bulkGetUserLocalesMock = jest.fn();
const emitOasisEventMock = jest.fn().mockResolvedValue(undefined);
let inserted: any = null;
let updatedAnnouncement: any = null;

jest.mock('../src/services/notification-service', () => ({
  notifyUser: (...args: any[]) => notifyUserMock(...args),
  notifyUserAsync: jest.fn(),
  sendPushToUser: jest.fn(),
  sendAppilixPush: jest.fn(),
  TYPE_META: {},
}));
jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn().mockResolvedValue('de'),
  bulkGetUserLocales: (...args: any[]) => bulkGetUserLocalesMock(...args),
}));
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => emitOasisEventMock(...args),
}));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'service-role-key';
jest.mock('@supabase/supabase-js', () => ({ createClient: () => mockSupabase }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/scheduled-notifications').default;
const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/scheduled-notifications', router);
  return app;
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const entry = (id: string, added: string) => ({
  id,
  added,
  title: { en: `T ${id}`, de: `Titel ${id}` },
  description: { en: `D ${id}`, de: `Beschr ${id}` },
  deepLink: `/${id}`,
});

function makeFakeSupabase(opts: {
  prior?: Array<{ created_by: string; created_at: string }>;
  priorError?: { message: string };
  insertResult?: { data: { id: string } | null; error: { message: string } | null };
  members?: Array<{ user_id: string }>;
}) {
  inserted = null;
  updatedAnnouncement = null;
  return {
    from: (table: string) => {
      if (table === 'feature_announcements') {
        const chain: any = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.like = () =>
          Promise.resolve({ data: opts.priorError ? null : opts.prior ?? [], error: opts.priorError ?? null });
        chain.insert = (row: any) => {
          inserted = row;
          return chain;
        };
        chain.single = () => Promise.resolve(opts.insertResult ?? { data: { id: 'ann-1' }, error: null });
        chain.update = (row: any) => {
          updatedAnnouncement = row;
          return chain;
        };
        return chain;
      }
      if (table === 'user_tenants') {
        const chain: any = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.order = () => chain;
        chain.range = () => chain;
        return Object.assign(chain, {
          then: (resolve: any) => resolve({ data: opts.members ?? [{ user_id: 'u1' }, { user_id: 'u2' }], error: null }),
        });
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
  };
}

const mockManifest = (entries: unknown[], ok = true) => {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 503,
    json: async () => ({ version: 1, entries }),
  });
};
const post = () =>
  request(makeApp()).post('/api/v1/scheduled-notifications/whats-new').send({ tenant_id: 'tenant-1' });

const realFetch = (global as any).fetch;
beforeEach(() => {
  delete process.env.WHATS_NEW_AUTOPUBLISH;
  notifyUserMock.mockReset().mockResolvedValue({ pushed: 1, inapp: true });
  emitOasisEventMock.mockClear();
  bulkGetUserLocalesMock.mockReset().mockResolvedValue(new Map([['u1', 'de'], ['u2', 'en']]));
});
afterAll(() => {
  (global as any).fetch = realFetch;
});

describe('whats-new publisher (pure)', () => {
  it('drops malformed entries without failing the rest', () => {
    const { entries, skipped } = parseWhatsNewManifest({
      entries: [entry('ok', daysAgo(1)), { id: 'Bad Id' }, { ...entry('no-de', daysAgo(1)), title: { en: 'x' } }],
    });
    expect(entries.map((e) => e.id)).toEqual(['ok']);
    expect(skipped).toBe(2);
  });

  it('picks the oldest fresh unpublished entry; skips stale and published', () => {
    const now = new Date();
    const list = [entry('stale', daysAgo(30)), entry('done', daysAgo(5)), entry('older', daysAgo(4)), entry('newer', daysAgo(1))];
    expect(selectNextWhatsNewEntry(list, new Set(['done']), now)?.id).toBe('older');
    expect(selectNextWhatsNewEntry(list, new Set(['done', 'older', 'newer']), now)).toBeNull();
  });
});

describe('POST /whats-new', () => {
  it('publishes the next entry tenant-wide and notifies every member', async () => {
    mockSupabase = makeFakeSupabase({});
    mockManifest([entry('feat-b', daysAgo(1)), entry('feat-a', daysAgo(2))]);
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, entry: 'feat-a', announcement_id: 'ann-1', dispatched: 2 });
    expect(inserted).toMatchObject({
      tenant_id: 'tenant-1',
      variant: 'brand-new-feature',
      deep_link: '/feat-a',
      created_by: `${WHATS_NEW_CREATED_BY_PREFIX}feat-a`,
      target_user_ids: null,
    });
    expect(notifyUserMock).toHaveBeenCalledTimes(2);
    expect(notifyUserMock.mock.calls[0][4]).toBeDefined();
    expect(updatedAnnouncement).toHaveProperty('notified_at');
    // OASIS: one state-transition event per published card, never per poll.
    expect(emitOasisEventMock).toHaveBeenCalledTimes(1);
    expect(emitOasisEventMock.mock.calls[0][0]).toMatchObject({
      type: 'notification.whats_new.dispatched',
      vtid: 'VTID-04733',
      payload: { entry: 'feat-a', announcement_id: 'ann-1', dispatched: 2 },
    });
  });

  it('never re-announces an entry already recorded for the tenant', async () => {
    mockSupabase = makeFakeSupabase({
      prior: [{ created_by: `${WHATS_NEW_CREATED_BY_PREFIX}feat-a`, created_at: '2020-01-01T00:00:00Z' }],
    });
    mockManifest([entry('feat-a', daysAgo(2))]);
    const r = await post();
    expect(r.body).toMatchObject({ ok: true, skipped: 'nothing_new' });
    expect(inserted).toBeNull();
    expect(notifyUserMock).not.toHaveBeenCalled();
    expect(emitOasisEventMock).not.toHaveBeenCalled();
  });

  it('publishes at most one card per gap', async () => {
    mockSupabase = makeFakeSupabase({
      prior: [{ created_by: `${WHATS_NEW_CREATED_BY_PREFIX}feat-a`, created_at: new Date().toISOString() }],
    });
    mockManifest([entry('feat-a', daysAgo(1)), entry('feat-b', daysAgo(1))]);
    const r = await post();
    expect(r.body).toMatchObject({ ok: true, skipped: 'published_recently' });
    expect(inserted).toBeNull();
  });

  it('never publishes a stale entry', async () => {
    mockSupabase = makeFakeSupabase({});
    mockManifest([entry('old', daysAgo(40))]);
    const r = await post();
    expect(r.body).toMatchObject({ ok: true, skipped: 'nothing_new' });
    expect(inserted).toBeNull();
  });

  it('honours the kill switch without touching anything', async () => {
    process.env.WHATS_NEW_AUTOPUBLISH = 'false';
    mockSupabase = makeFakeSupabase({});
    mockManifest([entry('feat-a', daysAgo(1))]);
    const r = await post();
    expect(r.body).toMatchObject({ ok: true, skipped: 'disabled' });
    expect((global as any).fetch).not.toHaveBeenCalled();
    expect(inserted).toBeNull();
  });

  it('502s (and publishes nothing) when the production manifest is unreachable', async () => {
    mockSupabase = makeFakeSupabase({});
    mockManifest([], false);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await post();
    expect(r.status).toBe(502);
    expect(inserted).toBeNull();
    errorSpy.mockRestore();
  });

  it('stops (does not guess) when the dedupe lookup fails', async () => {
    mockSupabase = makeFakeSupabase({ priorError: { message: 'db down' } });
    mockManifest([entry('feat-a', daysAgo(1))]);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await post();
    expect(r.status).toBe(500);
    expect(inserted).toBeNull();
    errorSpy.mockRestore();
  });

  it('500 when the announcement insert fails, and notifies no one', async () => {
    mockSupabase = makeFakeSupabase({ insertResult: { data: null, error: { message: 'boom' } } });
    mockManifest([entry('feat-a', daysAgo(1))]);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await post();
    expect(r.status).toBe(500);
    expect(notifyUserMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('counts only successful dispatches when some users reject', async () => {
    mockSupabase = makeFakeSupabase({});
    mockManifest([entry('feat-a', daysAgo(1))]);
    notifyUserMock.mockReset().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('boom'));
    const r = await post();
    expect(r.body).toMatchObject({ ok: true, dispatched: 1 });
  });
});
