// VTID-04409 — GET /api/v1/operator/threads: the caller's own server-side threads.
import { listOperatorThreads, THREAD_LIST_SUMMARY_CHARS } from '../src/services/operator-threads';

const USER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
let urls: string[] = [];
let rows: any[] = [];
let status = 200;

beforeEach(() => {
  urls = []; rows = []; status = 200;
  process.env.OPERATOR_THREADS_ENABLED = 'true';
  process.env.SUPABASE_URL = 'http://supa';
  process.env.SUPABASE_SERVICE_ROLE = 'k';
  (global as any).fetch = jest.fn(async (url: string) => {
    urls.push(url);
    return { ok: status < 300, status, text: async () => JSON.stringify(rows) } as any;
  });
});

describe('listOperatorThreads', () => {
  it('lists only the caller\'s threads, newest activity first, with clipped summaries', async () => {
    rows = [{ id: 't1', title: 'Fix CI', summary: 's'.repeat(2000), turns: 4, last_message_at: '2026-09-23T10:00:00Z', created_at: '2026-09-22T10:00:00Z' }];
    const r = await listOperatorThreads({ userId: USER, limit: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(urls[0]).toContain(`user_id=eq.${USER}`);
    expect(urls[0]).toContain('order=last_message_at.desc.nullslast');
    expect(urls[0]).toContain('limit=100');
    expect(r.threads[0].summary!.length).toBeLessThan(THREAD_LIST_SUMMARY_CHARS + 20);
  });

  it('a caller without a UUID identity has no threads and no query runs', async () => {
    expect(await listOperatorThreads({ userId: 'operator-machine-test-harness' })).toEqual({ ok: true, threads: [] });
    expect(await listOperatorThreads({ userId: null })).toEqual({ ok: true, threads: [] });
    expect(urls).toHaveLength(0);
  });

  it('reports disabled and unavailable honestly', async () => {
    process.env.OPERATOR_THREADS_ENABLED = 'false';
    expect(await listOperatorThreads({ userId: USER })).toEqual({ ok: false, error: 'disabled' });
    process.env.OPERATOR_THREADS_ENABLED = 'true';
    status = 500;
    expect(await listOperatorThreads({ userId: USER })).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('route wiring (source contract)', () => {
  it('is exafy_admin only and registered before the :threadId route', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/operator.ts'), 'utf8');
    const list = src.indexOf("router.get('/threads', requireAdminAuth");
    expect(list).toBeGreaterThan(-1);
    expect(list).toBeLessThan(src.indexOf("router.get('/threads/:threadId/messages'"));
  });
});
