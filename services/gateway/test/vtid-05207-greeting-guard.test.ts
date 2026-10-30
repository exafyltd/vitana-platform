/**
 * VTID-05207 — server-side "Say Hello 👋" greeting guard
 * (services/new-member-greeting-guard.ts), plan Part B / findings F10, F13.
 *
 * Golden scenarios over an in-memory Supabase-shaped stub, all with a fixed
 * clock. Every refusal reason answers the SAME generic code. Pure helpers are
 * unit-tested directly; the entry point is tested end to end.
 */
import {
  checkGreetingSend,
  receiverIsGreetableNewcomer,
  evaluateGreetingHistory,
  greetingMaxPerSenderHour,
  GREETING_REFUSED_CODE,
  GREETING_CARD_WINDOW_MS,
  NEW_MEMBER_GREETING_SOURCE,
  type SentGreetingRow,
} from '../src/services/new-member-greeting-guard';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const SENDER = 'sender-1';
const RECEIVER = 'newcomer-1';

// ---------------------------------------------------------------------------
// In-memory Supabase stub: one query builder per `.from(table)`, resolving to
// the rows the test seeded for that table. Only the methods the guard calls
// are modelled; an unseeded table resolves to [].
// ---------------------------------------------------------------------------
interface Seed {
  service_bot_accounts?: Array<{ user_id: string }>;
  notification_test_actors?: Array<{ user_id: string }>;
  user_blocked_authors?: Array<{ user_id: string; author_id: string }>;
  user_muted_authors?: Array<{ user_id: string; author_id: string }>;
  global_community_profiles?: Array<{ user_id: string; community_intro_opt_in: boolean | null; created_at: string | null }>;
  chat_messages?: Array<{ sender_id: string; receiver_id: string; created_at: string; metadata: Record<string, unknown> | null }>;
  errorOn?: string; // a table whose read returns { error }
}

const orderCalls: Array<[string, any]> = [];

function makeSb(seed: Seed): any {
  return {
    from(table: string) {
      const filters: Array<[string, any]> = [];
      let gte: string | null = null;
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: any) => {
          filters.push([col, val]);
          return builder;
        },
        gte: (_col: string, val: string) => {
          gte = val;
          return builder;
        },
        order: (col: string, opts: any) => {
          orderCalls.push([col, opts]);
          return builder;
        },
        limit: () => builder,
        maybeSingle: () => resolveMaybeSingle(),
        then: (resolve: any, reject: any) => resolveList().then(resolve, reject),
      };

      function error() {
        return seed.errorOn === table ? { message: `${table} boom` } : null;
      }
      function applyFilters(rows: any[]): any[] {
        let out = rows;
        for (const [col, val] of filters) out = out.filter((r) => r[col] === val);
        if (gte) out = out.filter((r) => r.created_at >= gte!);
        return out;
      }
      function rowsFor(): any[] {
        return applyFilters(((seed as any)[table] as any[]) ?? []);
      }
      async function resolveList() {
        return { data: rowsFor(), error: error() };
      }
      async function resolveMaybeSingle() {
        return { data: rowsFor()[0] ?? null, error: error() };
      }
      return builder;
    },
  };
}

function run(seed: Seed) {
  return checkGreetingSend({ sb: makeSb(seed), senderId: SENDER, receiverId: RECEIVER, tenantId: 'tenant-1', now: NOW });
}

const greetableProfile = {
  user_id: RECEIVER,
  community_intro_opt_in: true,
  created_at: new Date(NOW.getTime() - 2 * 24 * 3_600_000).toISOString(), // joined 2 days ago
};

function baseSeed(over: Partial<Seed> = {}): Seed {
  return {
    service_bot_accounts: [],
    notification_test_actors: [],
    user_blocked_authors: [],
    user_muted_authors: [],
    global_community_profiles: [greetableProfile],
    chat_messages: [],
    ...over,
  };
}

describe('pure helpers', () => {
  it('receiverIsGreetableNewcomer: opted-in and inside the 7-day window', () => {
    expect(receiverIsGreetableNewcomer({ community_intro_opt_in: true, created_at: greetableProfile.created_at }, NOW)).toBe(true);
  });
  it('receiverIsGreetableNewcomer: not opted in → false', () => {
    expect(receiverIsGreetableNewcomer({ community_intro_opt_in: false, created_at: greetableProfile.created_at }, NOW)).toBe(false);
    expect(receiverIsGreetableNewcomer({ community_intro_opt_in: null, created_at: greetableProfile.created_at }, NOW)).toBe(false);
  });
  it('receiverIsGreetableNewcomer: joined more than 7 days ago → false', () => {
    const old = new Date(NOW.getTime() - (GREETING_CARD_WINDOW_MS + 60_000)).toISOString();
    expect(receiverIsGreetableNewcomer({ community_intro_opt_in: true, created_at: old }, NOW)).toBe(false);
  });
  it('receiverIsGreetableNewcomer: missing row → false', () => {
    expect(receiverIsGreetableNewcomer(null, NOW)).toBe(false);
  });

  it('evaluateGreetingHistory: an earlier greeting to the pair → already_greeted', () => {
    const pair: SentGreetingRow[] = [{ created_at: NOW.toISOString(), metadata: { source: NEW_MEMBER_GREETING_SOURCE } }];
    expect(evaluateGreetingHistory(pair, [], NOW, 20)).toEqual({ allowed: false, reason: 'already_greeted' });
  });
  it('evaluateGreetingHistory: an ordinary (untagged) earlier DM to the pair does NOT block', () => {
    const pair: SentGreetingRow[] = [{ created_at: NOW.toISOString(), metadata: { foo: 'bar' } }];
    expect(evaluateGreetingHistory(pair, [], NOW, 20)).toEqual({ allowed: true });
  });
  it('evaluateGreetingHistory: at the hourly cap → hourly_cap', () => {
    const hour: SentGreetingRow[] = Array.from({ length: 3 }, () => ({
      created_at: NOW.toISOString(),
      metadata: { source: NEW_MEMBER_GREETING_SOURCE },
    }));
    expect(evaluateGreetingHistory([], hour, NOW, 3)).toEqual({ allowed: false, reason: 'hourly_cap' });
  });
  it('evaluateGreetingHistory: only greeting rows count toward the cap', () => {
    const hour: SentGreetingRow[] = [
      { created_at: NOW.toISOString(), metadata: { source: 'something_else' } },
      { created_at: NOW.toISOString(), metadata: null },
    ];
    expect(evaluateGreetingHistory([], hour, NOW, 1)).toEqual({ allowed: true });
  });

  it('greetingMaxPerSenderHour: env override, else default', () => {
    expect(greetingMaxPerSenderHour({ NEW_MEMBER_GREETING_MAX_PER_SENDER_HOUR: '5' } as any)).toBe(5);
    expect(greetingMaxPerSenderHour({} as any)).toBe(20);
  });
});

describe('checkGreetingSend — golden scenarios', () => {
  it('allows a clean greeting to an opted-in newcomer', async () => {
    const r = await run(baseSeed());
    expect(r.ok).toBe(true);
  });

  it('refuses when the receiver blocked the sender', async () => {
    const r = await run(baseSeed({ user_blocked_authors: [{ user_id: RECEIVER, author_id: SENDER }] }));
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('refuses when the receiver muted the sender', async () => {
    const r = await run(baseSeed({ user_muted_authors: [{ user_id: RECEIVER, author_id: SENDER }] }));
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('refuses a non-opted-in receiver', async () => {
    const r = await run(baseSeed({ global_community_profiles: [{ ...greetableProfile, community_intro_opt_in: false }] }));
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('refuses a receiver who joined more than 7 days ago', async () => {
    const old = new Date(NOW.getTime() - (GREETING_CARD_WINDOW_MS + 60_000)).toISOString();
    const r = await run(baseSeed({ global_community_profiles: [{ ...greetableProfile, created_at: old }] }));
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('refuses when the SENDER is a test/service account', async () => {
    const r = await run(baseSeed({ service_bot_accounts: [{ user_id: SENDER }] }));
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('refuses when the RECEIVER is a test/service account', async () => {
    const r = await run(baseSeed({ notification_test_actors: [{ user_id: RECEIVER }] }));
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('refuses a second greeting from the same sender to the same receiver', async () => {
    const r = await run(
      baseSeed({
        chat_messages: [
          { sender_id: SENDER, receiver_id: RECEIVER, created_at: new Date(NOW.getTime() - 3_600_000).toISOString(), metadata: { source: NEW_MEMBER_GREETING_SOURCE } },
        ],
      }),
    );
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('refuses when the sender is over the per-sender hourly cap', async () => {
    process.env.NEW_MEMBER_GREETING_MAX_PER_SENDER_HOUR = '2';
    const recent = (i: number) => ({
      sender_id: SENDER,
      receiver_id: `other-${i}`,
      created_at: new Date(NOW.getTime() - 60_000).toISOString(),
      metadata: { source: NEW_MEMBER_GREETING_SOURCE },
    });
    const r = await run(baseSeed({ chat_messages: [recent(1), recent(2)] }));
    delete process.env.NEW_MEMBER_GREETING_MAX_PER_SENDER_HOUR;
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('refuses (fail-closed) when the exclusion lookup errors', async () => {
    const r = await run(baseSeed({ errorOn: 'service_bot_accounts' }));
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('refuses (fail-closed) when a block/mute lookup errors', async () => {
    const r = await run(baseSeed({ errorOn: 'user_blocked_authors' }));
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('refuses greeting yourself', async () => {
    const r = await checkGreetingSend({ sb: makeSb(baseSeed()), senderId: SENDER, receiverId: SENDER, tenantId: 'tenant-1', now: NOW });
    expect(r).toEqual({ ok: false, code: GREETING_REFUSED_CODE });
  });

  it('reads the bounded DM history newest-first (deterministic)', async () => {
    orderCalls.length = 0;
    await checkGreetingSend({ sb: makeSb(baseSeed()), senderId: SENDER, receiverId: RECEIVER, tenantId: 'tenant-1', now: NOW });
    expect(orderCalls.length).toBe(2);
    for (const [col, opts] of orderCalls) {
      expect(col).toBe('created_at');
      expect(opts).toEqual({ ascending: false });
    }
  });
});
