/** VTID-05658 — middleware + daily-seen recorder. The classifier lane (#4917) is mocked; writes go to an in-memory double. */
import { EventEmitter } from 'events';

jest.mock(
  '../src/services/client-identity/classify',
  () => ({
    CLIENT_HEADER: 'X-Vitana-Client',
    classifyClient: (v: string | string[] | null | undefined) => {
      const s = Array.isArray(v) ? v[0] : v;
      return typeof s === 'string' && /^native\/(ios|android|test)\/[0-9A-Za-z.]+$/.test(s) ? 'native' : 'web';
    },
  }),
  { virtual: true },
);
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));

import { clientIdentity } from '../src/middleware/client-identity';
import { createSeenRecorder, type SeenRow } from '../src/services/client-adoption/seen-store';

const U = '11111111-1111-1111-1111-111111111111';
const T = '22222222-2222-2222-2222-222222222222';

function run(opts: {
  header?: string;
  identity?: any;
  recorder: ReturnType<typeof createSeenRecorder>;
}) {
  const req: any = { headers: opts.header ? { 'x-vitana-client': opts.header } : {} };
  const res: any = new EventEmitter();
  res.headers = {} as Record<string, string>;
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  let calledNext = false;
  clientIdentity(opts.recorder)(req, res, () => {
    calledNext = true;
    // header must already be set when next() is called
    expect(res.headers['X-Vitana-Client-Class']).toBeDefined();
    // route-level auth runs AFTER the middleware
    if (opts.identity) req.identity = opts.identity;
  });
  return { req, res, finish: () => res.emit('finish'), calledNext: () => calledNext };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('client-identity middleware', () => {
  let rows: SeenRow[];
  let recorder: ReturnType<typeof createSeenRecorder>;
  beforeEach(() => {
    rows = [];
    recorder = createSeenRecorder(async (r) => { rows.push(r); }, () => new Date('2026-11-08T10:00:00Z'));
  });

  it('echoes native and web before next()', () => {
    const a = run({ header: 'native/ios/1.2.3', recorder });
    expect(a.res.headers['X-Vitana-Client-Class']).toBe('native');
    expect(a.calledNext()).toBe(true);
    const b = run({ recorder });
    expect(b.res.headers['X-Vitana-Client-Class']).toBe('web');
    const c = run({ header: 'garbage', recorder });
    expect(c.res.headers['X-Vitana-Client-Class']).toBe('web');
  });

  it('no write without identity', async () => {
    run({ header: 'native/ios/1.0', recorder }).finish();
    await flush();
    expect(rows).toHaveLength(0);
  });

  it('no write when user_id or tenant_id is null (R2-F1)', async () => {
    run({ identity: { user_id: U, tenant_id: null }, recorder }).finish();
    run({ identity: { user_id: null, tenant_id: T }, recorder }).finish();
    run({ identity: { user_id: U }, recorder }).finish();
    await flush();
    expect(rows).toHaveLength(0);
  });

  it('reads req.identity at finish (set after mount) and records class', async () => {
    run({ header: 'native/android/2.0', identity: { user_id: U, tenant_id: T }, recorder }).finish();
    await flush();
    expect(rows).toEqual([{ day: '2026-11-08', tenant_id: T, user_id: U, client_class: 'native' }]);
  });

  it('one upsert per member/class/day, a second class is a second row', async () => {
    for (let i = 0; i < 5; i++) run({ identity: { user_id: U, tenant_id: T }, recorder }).finish();
    run({ header: 'native/ios/1.0', identity: { user_id: U, tenant_id: T }, recorder }).finish();
    await flush();
    expect(rows.map((r) => r.client_class).sort()).toEqual(['native', 'web']);
  });

  it('writes again on a new UTC day', async () => {
    let now = new Date('2026-11-08T23:59:00Z');
    const rec = createSeenRecorder(async (r) => { rows.push(r); }, () => now);
    run({ identity: { user_id: U, tenant_id: T }, recorder: rec }).finish();
    now = new Date('2026-11-09T00:01:00Z');
    run({ identity: { user_id: U, tenant_id: T }, recorder: rec }).finish();
    await flush();
    expect(rows.map((r) => r.day)).toEqual(['2026-11-08', '2026-11-09']);
  });

  it('a failing (rejecting) writer never fails the request', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = createSeenRecorder(async () => { throw new Error('relation does not exist'); });
    const r = run({ identity: { user_id: U, tenant_id: T }, recorder: bad });
    expect(() => r.finish()).not.toThrow();
    await flush();
    expect(r.calledNext()).toBe(true);
    warn.mockRestore();
  });

  it('a synchronously throwing writer never throws, and backs off', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const writer = jest.fn(() => { throw new Error('boom'); });
    const bad = createSeenRecorder(writer as any, () => new Date('2026-11-08T10:00:00Z'));
    expect(() => {
      run({ identity: { user_id: U, tenant_id: T }, recorder: bad }).finish();
    }).not.toThrow();
    await flush();
    expect(() => {
      run({ identity: { user_id: '33333333-3333-3333-3333-333333333333', tenant_id: T }, recorder: bad }).finish();
    }).not.toThrow();
    await flush();
    expect(writer).toHaveBeenCalledTimes(1); // second call suppressed by back-off
    warn.mockRestore();
  });

  it('a throwing recorder never breaks finish', () => {
    const boom: any = { record: () => { throw new Error('x'); }, reset() {} };
    const r = run({ identity: { user_id: U, tenant_id: T }, recorder: boom });
    expect(() => r.finish()).not.toThrow();
  });
});
