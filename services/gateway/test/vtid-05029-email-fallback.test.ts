// VTID-05029 — email backstop for important notifications a push never reached.
//
// One digest per member, at most one per 6 h; only allowlisted types/priorities
// whose push_outcome is no_device/fcm_error, unread, 1-24 h old. Skips test and
// service accounts, push opt-out, email opt-out, no confirmed email. Stamps
// email_fallback_sent_at only after Resend accepted the email. Inert unless
// EMAIL_FALLBACK_ENABLED=true + Resend configured, never on staging.
import {
  runEmailFallbackTick,
  isEmailFallbackEnabled,
  isFallbackWorthy,
  groupByMember,
  buildFallbackDigestEmail,
  startEmailFallbackLoop,
  EMAIL_FALLBACK_MAX_ITEMS,
  type FallbackCandidate,
} from '../src/services/email/notification-email-fallback';

type Row = Record<string, any>;

/** Minimal in-memory PostgREST-style client for the calls the job makes. */
function fakeDb(tables: Record<string, Row[]>) {
  const updates: Array<{ table: string; patch: Row; ids: unknown[] }> = [];
  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    let limit = Infinity;
    const run = () => {
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return rows.slice(0, limit);
    };
    const b: any = {
      select: () => b,
      in: (c: string, v: unknown[]) => {
        filters.push((r) => v.includes(r[c]));
        if (patch) {
          const ids = v;
          for (const r of run()) Object.assign(r, patch);
          updates.push({ table, patch, ids });
          return Promise.resolve({ error: null });
        }
        return b;
      },
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      gte: (c: string, v: string) => (filters.push((r) => r[c] != null && r[c] >= v), b),
      lte: (c: string, v: string) => (filters.push((r) => r[c] != null && r[c] <= v), b),
      order: (c: string) => {
        filters.push(() => true);
        tables[table]?.sort((x, y) => String(x[c]).localeCompare(String(y[c])));
        return b;
      },
      limit: (n: number) => {
        limit = n;
        return Promise.resolve({ data: run(), error: null });
      },
      update: (p: Row) => ((patch = p), b),
      then: (res: any, rej: any) => Promise.resolve({ data: run(), error: null }).then(res, rej),
    };
    return b;
  }
  return { client: { from: (t: string) => builder(t) } as any, updates };
}

const NOW = Date.parse('2026-10-10T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function notif(id: string, user: string, extra: Row = {}): Row {
  return {
    id, user_id: user, type: 'new_chat_message', priority: 'p1', title: `T-${id}`,
    created_at: hoursAgo(2), push_outcome: 'no_device', read_at: null, email_fallback_sent_at: null, ...extra,
  };
}

function deps(over: Partial<Parameters<typeof runEmailFallbackTick>[1]> = {}) {
  const sent: any[] = [];
  return {
    sent,
    d: {
      now: () => NOW,
      send: jest.fn(async (m: any) => { sent.push(m); return { ok: true as const, status: 'sent' as const, id: 'r1' }; }),
      getLocales: async (ids: string[]) => new Map(ids.map((i) => [i, 'de' as const])),
      getConfirmedEmail: async (id: string) => `${id}@example.com`,
      env: { APP_BASE_URL: 'https://app.example' } as any,
      ...over,
    },
  };
}

describe('enablement', () => {
  const on = { EMAIL_FALLBACK_ENABLED: 'true', RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c', VITANA_ENV: 'production' } as any;
  test('needs the flag, Resend config and a non-staging env', () => {
    expect(isEmailFallbackEnabled(on)).toBe(true);
    expect(isEmailFallbackEnabled({ ...on, EMAIL_FALLBACK_ENABLED: 'TRUE' })).toBe(false);
    expect(isEmailFallbackEnabled({ ...on, RESEND_API_KEY: '' })).toBe(false);
    expect(isEmailFallbackEnabled({ ...on, EMAIL_FROM: undefined })).toBe(false);
    expect(isEmailFallbackEnabled({ ...on, VITANA_ENV: 'staging' })).toBe(false);
  });

  test('loop does not start when unconfigured (default env)', () => {
    const saved = { ...process.env };
    delete process.env.EMAIL_FALLBACK_ENABLED;
    expect(startEmailFallbackLoop(() => null)).toBe(false);
    process.env = saved;
  });
});

describe('selection and grouping', () => {
  test('allowlist: chat, reminder, any p0/p1; not p2 community types', () => {
    expect(isFallbackWorthy({ type: 'new_chat_message', priority: 'p2' })).toBe(true);
    expect(isFallbackWorthy({ type: 'reminder_due', priority: null })).toBe(true);
    expect(isFallbackWorthy({ type: 'live_room_starting', priority: 'p0' })).toBe(true);
    expect(isFallbackWorthy({ type: 'post_comment', priority: 'p1' })).toBe(true);
    expect(isFallbackWorthy({ type: 'community_post_published', priority: 'p2' })).toBe(false);
  });

  test('groups by member, oldest first, drops non-allowlisted rows', () => {
    const rows = [
      notif('b', 'u1', { created_at: hoursAgo(2) }),
      notif('a', 'u1', { created_at: hoursAgo(3) }),
      notif('c', 'u2', { type: 'community_post_published', priority: 'p2' }),
    ] as FallbackCandidate[];
    const g = groupByMember(rows);
    expect([...g.keys()]).toEqual(['u1']);
    expect(g.get('u1')!.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('runEmailFallbackTick', () => {
  function base(extra: Row[] = []) {
    return {
      user_notifications: [notif('n1', 'u1'), notif('n2', 'u1', { type: 'reminder_due' }), ...extra],
      notification_test_actors: [] as Row[],
      service_bot_accounts: [] as Row[],
      user_notification_preferences: [] as Row[],
    };
  }

  test('one digest per member, rows stamped after send', async () => {
    const t = base([notif('n3', 'u2')]);
    const db = fakeDb(t);
    const { d, sent } = deps();
    const r = await runEmailFallbackTick(db.client, d);
    expect(r).toEqual(expect.objectContaining({ ok: true, members: 2, sent: 2, failed: 0 }));
    expect(sent.map((m) => m.to).sort()).toEqual(['u1@example.com', 'u2@example.com']);
    expect(t.user_notifications.every((n) => n.email_fallback_sent_at === new Date(NOW).toISOString())).toBe(true);
  });

  test('only no_device / fcm_error, unread, not yet emailed, 1-24 h old', async () => {
    const t = base();
    t.user_notifications = [
      notif('ok', 'u1'),
      notif('delivered', 'u2', { push_outcome: 'delivered_appilix' }),
      notif('suppressed', 'u3', { push_outcome: 'suppressed_dnd' }),
      notif('read', 'u4', { read_at: hoursAgo(1) }),
      notif('done', 'u5', { email_fallback_sent_at: hoursAgo(10) }),
      notif('fresh', 'u6', { created_at: hoursAgo(0.5) }),
      notif('old', 'u7', { created_at: hoursAgo(30) }),
      notif('fcm', 'u8', { push_outcome: 'fcm_error' }),
    ];
    const { d, sent } = deps();
    await runEmailFallbackTick(fakeDb(t).client, d);
    expect(sent.map((m) => m.to).sort()).toEqual(['u1@example.com', 'u8@example.com']);
  });

  test('skip rules: test/service accounts, push off, email opt-out, no confirmed email', async () => {
    const t = base();
    t.user_notifications = ['ta', 'bot', 'off', 'optout', 'noemail', 'ok'].map((u) => notif(`n-${u}`, u));
    t.notification_test_actors = [{ user_id: 'ta' }];
    t.service_bot_accounts = [{ user_id: 'bot' }];
    t.user_notification_preferences = [
      { user_id: 'off', push_enabled: false, email_fallback_enabled: true },
      { user_id: 'optout', push_enabled: true, email_fallback_enabled: false },
    ];
    const { d, sent } = deps({ getConfirmedEmail: async (id: string) => (id === 'noemail' ? null : `${id}@example.com`) });
    const r = await runEmailFallbackTick(fakeDb(t).client, d);
    expect(sent.map((m) => m.to)).toEqual(['ok@example.com']);
    expect(r.skipped).toEqual({ test_or_service_account: 2, push_disabled: 1, email_opt_out: 1, no_confirmed_email: 1 });
    expect(t.user_notifications.find((n) => n.id === 'n-noemail')!.email_fallback_sent_at).toBeNull();
  });

  test('6 h cap: a member emailed within 6 h is skipped', async () => {
    const t = base([notif('earlier', 'u1', { email_fallback_sent_at: hoursAgo(5), created_at: hoursAgo(8) })]);
    const { d, sent } = deps();
    const r = await runEmailFallbackTick(fakeDb(t).client, d);
    expect(sent).toHaveLength(0);
    expect(r.skipped.recently_emailed).toBe(1);
  });

  test('cap expired after 6 h → emailed again', async () => {
    const t = base([notif('earlier', 'u1', { email_fallback_sent_at: hoursAgo(7), created_at: hoursAgo(20) })]);
    const { d, sent } = deps();
    await runEmailFallbackTick(fakeDb(t).client, d);
    expect(sent).toHaveLength(1);
  });

  test('a failed send stamps nothing (retried next tick)', async () => {
    const t = base();
    const { d } = deps({ send: jest.fn(async () => ({ ok: false as const, status: 'failed' as const, error: 'Resend 500' })) });
    const r = await runEmailFallbackTick(fakeDb(t).client, d);
    expect(r).toEqual(expect.objectContaining({ sent: 0, failed: 1 }));
    expect(t.user_notifications.every((n) => n.email_fallback_sent_at === null)).toBe(true);
  });

  test('nothing to do → no send, no lookups beyond the candidate read', async () => {
    const t = base();
    t.user_notifications = [];
    const { d } = deps();
    const r = await runEmailFallbackTick(fakeDb(t).client, d);
    expect(r).toEqual(expect.objectContaining({ ok: true, candidates: 0, members: 0, sent: 0 }));
    expect(d.send).not.toHaveBeenCalled();
  });
});

describe('buildFallbackDigestEmail', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({
    id: `i${i}`, user_id: 'u', type: 'new_chat_message', priority: 'p1', title: `Anna <${i}>`, created_at: hoursAgo(2),
  }));

  test('DE copy, titles only (escaped), at most 5 plus a "more" line, app links', () => {
    const m = buildFallbackDigestEmail({ to: 'x@y.z', items, locale: 'de', env: { APP_BASE_URL: 'https://app.example/' } as any });
    expect(m.subject).toBe('Du hast etwas auf Vitanaland verpasst');
    expect(m.text).toContain('… und 2 weitere');
    expect((m.text.match(/^- /gm) ?? []).length).toBe(EMAIL_FALLBACK_MAX_ITEMS);
    expect(m.html).toContain('Anna &lt;0&gt;');
    expect(m.html).not.toContain('Anna <0>');
    expect(m.html).toContain('https://app.example/inbox');
    expect(m.html).toContain('https://app.example/settings/notifications');
    expect(m.html).not.toMatch(/<img/i);
  });

  test('English and RTL Arabic', () => {
    expect(buildFallbackDigestEmail({ to: 'x', items: items.slice(0, 1), locale: 'en' }).subject).toBe('You missed something on Vitanaland');
    const ar = buildFallbackDigestEmail({ to: 'x', items: items.slice(0, 1), locale: 'ar' });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).not.toContain('…');
  });
});
