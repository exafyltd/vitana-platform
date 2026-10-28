// VTID-05309 (messenger-ux-v2/api-message-search) — GET /api/v1/chat/search (plan I5).
//
// Authorization is the point of these tests: user C never sees an A↔B DM, a
// non-member never sees a group's messages, another tenant never, and a group
// scope the caller is not in is 403. The in-memory Supabase below applies the
// simple filters (eq / is / neq / in / ilike) and the cursor, but IGNORES every
// other `or` filter, as if the visibility filter were wrong — so the route's
// second, row-level check is what keeps the results clean. With
// `ignoreTenantEq` it also ignores the tenant filter. The `or` strings
// themselves are asserted separately.

import express from 'express';
import request from 'supertest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const G = '44444444-4444-4444-8444-444444444444';
const G2 = '55555555-5555-4555-8555-555555555555';
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Row = Record<string, any>;
const db: Record<string, Row[]> = { chat_messages: [], chat_group_members: [] };
const orCalls: string[] = [];
let ignoreTenantEq = false;
// SQL LIKE (backslash escapes) → RegExp, case-insensitive.
function likeToRegExp(p: string): RegExp {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\' && i + 1 < p.length) { out += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (ch === '%') out += '[\\s\\S]*';
    else if (ch === '_') out += '[\\s\\S]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}
const CURSOR_OR = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/;
class Q {
  private f: Array<(r: Row) => boolean> = [];
  private lim = 1000;
  constructor(private t: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { if (!(c === 'tenant_id' && ignoreTenantEq)) this.f.push((r) => r[c] === v); return this; }
  ilike(c: string, p: string) { const re = likeToRegExp(p); this.f.push((r) => re.test(String(r[c] ?? ''))); return this; }
  neq(c: string, v: unknown) { this.f.push((r) => r[c] !== v); return this; }
  is(c: string, v: null) { this.f.push((r) => (r[c] ?? null) === v); return this; }
  in(c: string, vs: unknown[]) { this.f.push((r) => vs.includes(r[c])); return this; }
  gte(c: string, v: string) { this.f.push((r) => r[c] >= v); return this; }
  lte(c: string, v: string) { this.f.push((r) => r[c] <= v); return this; }
  or(s: string) {
    orCalls.push(s);
    const m = CURSOR_OR.exec(s);
    if (m) this.f.push((r) => r.created_at < m[1] || (r.created_at === m[2] && r.id < m[3]));
    return this;
  }
  order() { return this; }
  limit(n: number) { this.lim = n; return this; }
  then(resolve: any, reject: any) {
    const rows = (db[this.t] ?? []).filter((r) => this.f.every((x) => x(r)))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1))
      .slice(0, this.lim);
    return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  }
}
const sb = { from: (t: string) => new Q(t) };
jest.mock('@supabase/supabase-js', () => ({ createClient: () => sb }));
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = 'k';

let caller = { user_id: C, tenant_id: T1 };
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.identity = { ...caller }; next(); },
  requireTenant: (_req: any, _res: any, next: any) => next(),
}));

import searchRouter, {
  escapeLike, quoteFilterValue, parseScope, encodeCursor, decodeCursor, snippetFor, visibilityFilter, likeValue, fileNameFilter, cursorFilter,
} from '../src/routes/chat-search';

const app = express();
app.use('/chat/search', searchRouter);

let n = 0;
const id = () => `66666666-6666-4666-8666-${String(++n).padStart(12, '0')}`;
function msg(over: Row): Row {
  return {
    id: id(), tenant_id: T1, receiver_id: null, group_id: null, message_type: 'text', metadata: null,
    created_at: new Date(Date.UTC(2026, 9, 21, 10, n)).toISOString(), ...over,
  };
}
const search = (qs: string) => request(app).get(`/chat/search?${qs}`);

beforeEach(() => {
  n = 0;
  orCalls.length = 0;
  ignoreTenantEq = false;
  caller = { user_id: C, tenant_id: T1 };
  db.chat_group_members = [
    { user_id: A, group_id: G, tenant_id: T1 },
    { user_id: B, group_id: G, tenant_id: T1 },
    { user_id: C, group_id: G2, tenant_id: T1 },
  ];
  db.chat_messages = [
    msg({ sender_id: A, receiver_id: B, content: 'secret plan between A and B' }),
    msg({ sender_id: B, receiver_id: A, content: 'the plan is fine' }),
    msg({ sender_id: A, group_id: G, content: 'group plan for G members' }),
    msg({ sender_id: C, group_id: G2, content: 'plan in my own group' }),
    msg({ sender_id: A, receiver_id: C, content: 'a plan for C' }),
    msg({ sender_id: A, receiver_id: C, content: 'other tenant plan', tenant_id: T2 }),
  ];
});

describe('authorization (the visibility filter is ignored by the mock; the row check must hold)', () => {
  it('user C never sees an A↔B DM, a group C is not in, or another tenant', async () => {
    const r = await search('q=plan');
    expect(r.status).toBe(200);
    const snippets = r.body.results.map((x: any) => x.snippet);
    expect(snippets).toEqual(expect.arrayContaining(['a plan for C', 'plan in my own group']));
    expect(snippets).toHaveLength(2);
    for (const s of ['secret plan between A and B', 'the plan is fine', 'group plan for G members', 'other tenant plan']) {
      expect(snippets).not.toContain(s);
    }
  });

  it('A sees the DM with B and group G; keys are from A\'s point of view', async () => {
    caller = { user_id: A, tenant_id: T1 };
    const r = await search('q=plan');
    const keys = r.body.results.map((x: any) => x.conversation_key).sort();
    expect(keys).toEqual([`dm:${B}`, `dm:${B}`, `dm:${C}`, `group:${G}`].sort());
  });

  it('the query asks only for the caller\'s DMs and groups, in the caller\'s tenant', async () => {
    caller = { user_id: A, tenant_id: T1 };
    await search('q=plan');
    expect(orCalls[0]).toBe(visibilityFilter(A, [G]));
    expect(orCalls[0]).toBe(`and(group_id.is.null,receiver_id.not.is.null,sender_id.eq.${A}),and(group_id.is.null,receiver_id.eq.${A}),group_id.in.(${G})`);
  });

  it('another tenant\'s rows are dropped by the row check even when the tenant filter is broken', async () => {
    ignoreTenantEq = true;
    const r = await search('q=plan');
    expect(r.body.results.map((x: any) => x.snippet)).not.toContain('other tenant plan');
    expect(r.body.results).toHaveLength(2);
  });

  it('a deleted group\'s rows (group_id NULL, no receiver) never show as a DM', async () => {
    db.chat_messages.push(msg({ sender_id: C, content: 'plan from a deleted group' }));
    const r = await search('q=plan');
    expect(r.body.results.map((x: any) => x.conversation_key)).not.toContain('dm:null');
    expect(r.body.results.map((x: any) => x.snippet)).not.toContain('plan from a deleted group');
  });

  it('scope=group:<id> for a non-member → 403; for a member → only that group', async () => {
    expect((await search(`q=plan&scope=group:${G}`)).status).toBe(403);
    const r = await search(`q=plan&scope=group:${G2}`);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => x.conversation_key)).toEqual([`group:${G2}`]);
  });

  it('scope=dm:<peer> never returns the caller\'s other DMs', async () => {
    db.chat_messages.push(msg({ sender_id: B, receiver_id: C, content: 'plan from B to C' }));
    const r = await search(`q=plan&scope=dm:${A}`);
    expect(r.body.results.map((x: any) => x.snippet)).toEqual(['a plan for C']);
  });

  it('scope=dm:<peer> returns only that DM, never another pair\'s', async () => {
    const r = await search(`q=plan&scope=dm:${A}`);
    expect(r.body.results.map((x: any) => x.snippet)).toEqual(['a plan for C']);
    expect(orCalls[0]).toBe(`and(sender_id.eq.${C},receiver_id.eq.${A}),and(sender_id.eq.${A},receiver_id.eq.${C})`);
  });
});

describe('query rules', () => {
  it('q shorter than 3 characters → 400', async () => {
    expect((await search('q=pl')).status).toBe(400);
    expect((await search('q=%20%20pl%20')).body.error).toBe('query_too_short');
  });

  it('LIKE wildcards are escaped: a "%" query matches a literal "%" only', async () => {
    db.chat_messages.push(msg({ sender_id: A, receiver_id: C, content: 'we hit 100% today' }));
    db.chat_messages.push(msg({ sender_id: A, receiver_id: C, content: 'we hit 1000 today' }));
    const r = await search(`q=${encodeURIComponent('00%')}`);
    expect(r.body.results.map((x: any) => x.snippet)).toEqual(['we hit 100% today']);
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
    expect(orCalls).toContain(fileNameFilter('00%'));
    expect(likeValue('00%')).toBe(quoteFilterValue('%00\\%%'));
  });

  it('the q filter value is quoted, so commas and parentheses cannot break out of it', () => {
    expect(quoteFilterValue('%a,b)c"d%')).toBe('"%a,b)c\\"d%"');
    expect(fileNameFilter('x),or(id.neq.0')).not.toMatch(/ilike\.%x\),or\(/);
  });

  it('type=image returns only messages whose attachments include an image', async () => {
    db.chat_messages.push(msg({ sender_id: A, receiver_id: C, message_type: 'attachment', content: 'photo of the plan',
      metadata: { attachments: [{ type: 'file', mime: 'image/png', filename: 'a.png' }] } }));
    db.chat_messages.push(msg({ sender_id: A, receiver_id: C, message_type: 'attachment', content: 'pdf of the plan',
      metadata: { attachments: [{ type: 'file', mime: 'application/pdf', filename: 'plan.pdf' }] } }));
    const r = await search('q=plan&type=image');
    expect(r.body.results.map((x: any) => x.snippet)).toEqual(['photo of the plan']);
    const f = await search('q=plan&type=file');
    expect(f.body.results.map((x: any) => x.snippet)).toEqual(['pdf of the plan']);
  });

  it('a file name matches; its snippet is the file name', async () => {
    db.chat_messages.push(msg({ sender_id: A, receiver_id: C, message_type: 'attachment', content: '',
      metadata: { attachments: [{ type: 'file', mime: 'application/pdf', filename: 'Budget-2026.pdf' }] } }));
    const r = await search('q=budget');
    expect(r.body.results.map((x: any) => x.snippet)).toEqual(['Budget-2026.pdf']);
  });

  it('sender, from/to and invalid parameters', async () => {
    const s = await search(`q=plan&sender=${C}`);
    expect(s.body.results.map((x: any) => x.snippet)).toEqual(['plan in my own group']);
    expect((await search('q=plan&scope=dm:nope')).status).toBe(400);
    expect((await search('q=plan&type=gif')).status).toBe(400);
    expect((await search('q=plan&from=yesterday')).status).toBe(400);
    expect((await search('q=plan&cursor=zzz')).status).toBe(400);
    // Date.parse accepts these, the strict ISO check does not: never reaches the filter.
    for (const ts of ['Oct 21 2026 (x,y)', '1', '2026-10-21, 10:00']) {
      const bad = Buffer.from(`${ts}|${A}`, 'utf8').toString('base64url');
      expect((await search(`q=plan&cursor=${bad}`)).status).toBe(400);
    }
    expect(decodeCursor(encodeCursor({ created_at: '2026-10-21T10:00:00.123456+00:00', id: A }))?.created_at).toBe('2026-10-21T10:00:00.123456+00:00');
  });

  it('newest first with a cursor; the next page continues where the first ended', async () => {
    for (let i = 0; i < 5; i++) db.chat_messages.push(msg({ sender_id: A, receiver_id: C, content: `plan item ${i}` }));
    const p1 = await search('q=plan+item&limit=2');
    expect(p1.body.results.map((x: any) => x.snippet)).toEqual(['plan item 4', 'plan item 3']);
    expect(p1.body.next_cursor).toEqual(expect.any(String));
    const c = decodeCursor(p1.body.next_cursor)!;
    expect(c.id).toBe(p1.body.results[1].message_id);
    expect(orCalls.some((o) => o.startsWith('created_at.lt.'))).toBe(false);
    const p2 = await search(`q=plan+item&limit=2&cursor=${p1.body.next_cursor}`);
    expect(orCalls).toContain(cursorFilter(c));
    expect(p2.body.results.map((x: any) => x.snippet)).toEqual(['plan item 2', 'plan item 1']);
    const p3 = await search(`q=plan+item&limit=2&cursor=${p2.body.next_cursor}`);
    expect(p3.body.results.map((x: any) => x.snippet)).toEqual(['plan item 0']);
    expect(p3.body.next_cursor).toBeNull();
  });

  it('a full scan window of rows the re-check drops gives a short page with a cursor', async () => {
    // limit=1 → scan window 3; three newer A↔B rows (invisible to C) fill it.
    for (let i = 0; i < 3; i++) db.chat_messages.push(msg({ sender_id: A, receiver_id: B, content: `hidden plan ${i}` }));
    const r = await search('q=plan&limit=1');
    expect(r.body.results).toEqual([]);
    expect(r.body.next_cursor).toEqual(expect.any(String));
    const next = await search(`q=plan&limit=1&cursor=${r.body.next_cursor}`);
    expect(next.body.results.map((x: any) => x.snippet)).toEqual(['a plan for C']);
  });

  it('type=voice and type=link', async () => {
    db.chat_messages.push(msg({ sender_id: A, receiver_id: C, message_type: 'voice', content: 'voice plan',
      metadata: { attachments: [{ type: 'voice', url: 'u' }] } }));
    db.chat_messages.push(msg({ sender_id: A, receiver_id: C, content: 'plan at https://example.com/x' }));
    expect((await search('q=plan&type=voice')).body.results.map((x: any) => x.snippet)).toEqual(['voice plan']);
    expect((await search('q=plan&type=link')).body.results.map((x: any) => x.snippet)).toEqual(['plan at https://example.com/x']);
  });

  it('a file name is matched by "name" too when "filename" is set', async () => {
    db.chat_messages.push(msg({ sender_id: A, receiver_id: C, message_type: 'attachment', content: '',
      metadata: { attachments: [{ type: 'file', filename: 'x.pdf', name: 'Quarterly-Report.pdf' }] } }));
    expect((await search('q=quarterly')).body.results.map((x: any) => x.snippet)).toEqual(['Quarterly-Report.pdf']);
  });
});

describe('helpers', () => {
  it('snippet: ±60 characters around the first hit with ellipses', () => {
    const text = `${'x'.repeat(100)}needle${'y'.repeat(100)}`;
    const s = snippetFor({ content: text } as any, 'NEEDLE');
    expect(s).toBe(`…${'x'.repeat(60)}needle${'y'.repeat(60)}…`);
  });

  it('scope and cursor parsing', () => {
    expect(parseScope(undefined)).toEqual({ kind: 'all' });
    expect(parseScope(`group:${G}`)).toEqual({ kind: 'group', groupId: G });
    expect(parseScope('dm:x')).toBeNull();
    const c = { created_at: '2026-10-21T10:00:00.000Z', id: A };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});

describe('rate limit', () => {
  it('the 31st search within a minute by one member → 429 (another member is not affected)', async () => {
    caller = { user_id: '77777777-7777-4777-8777-777777777777', tenant_id: T1 };
    for (let i = 0; i < 30; i++) expect((await search('q=plan')).status).toBe(200);
    const r = await search('q=plan');
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('RATE_LIMIT_EXCEEDED');
    caller = { user_id: '88888888-8888-4888-8888-888888888888', tenant_id: T1 };
    expect((await search('q=plan')).status).toBe(200);
  });
});
