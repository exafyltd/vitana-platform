/**
 * VTID-05148 — the write_test finding insert in routes/test-contracts-missing.ts
 * is exported for the learn-outcomes routine without changing what the
 * allocate route sends.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn(),
  requireAuthWithTenant: jest.fn(),
}));
jest.mock('../src/services/operator-service', () => ({ allocateVtid: jest.fn() }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn() }));

process.env.SUPABASE_URL = 'https://supa.test';
process.env.SUPABASE_SERVICE_ROLE = 'svc';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { insertMissingTestRecommendation } = require('../src/routes/test-contracts-missing');

const base = {
  id: 'rec-1',
  title: 'Write missing test contract: cap',
  summary: 'Endpoint /x (file f.ts) has no test contract.',
  spec_markdown: '# spec',
  files_referenced: ['services/gateway/src/services/test-contract-commands.ts', 'f.ts'],
  dedupe_key: 'k1',
  capability: 'cap',
  target_endpoint: '/x',
};

function stubFetch() {
  const calls: Array<{ url: string; init: any }> = [];
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: true, status: 201, text: async () => '' };
  });
  return calls;
}

describe('insertMissingTestRecommendation', () => {
  it('POSTs the exact row the allocate route always sent (source, risk, eligibility, spec_snapshot)', async () => {
    const calls = stubFetch();
    const res = await insertMissingTestRecommendation(base);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://supa.test/rest/v1/autopilot_recommendations');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({ apikey: 'svc', Authorization: 'Bearer svc', Prefer: 'return=minimal' });
    expect(JSON.parse(calls[0].init.body)).toEqual({
      id: 'rec-1',
      title: base.title,
      summary: base.summary,
      source_type: 'missing-test-scanner',
      status: 'new',
      risk_class: 'low',
      impact_score: 6,
      effort_score: 3,
      auto_exec_eligible: true,
      domain: 'gateway',
      spec_snapshot: {
        spec_markdown: '# spec',
        files_referenced: base.files_referenced,
        scanner: 'missing-test-scanner',
        dedupe_key: 'k1',
        capability: 'cap',
        target_endpoint: '/x',
      },
    });
  });

  it('extra_snapshot only adds keys inside spec_snapshot', async () => {
    const calls = stubFetch();
    await insertMissingTestRecommendation({ ...base, extra_snapshot: { repair_kind: 'write_test', source: 'learn-outcomes' } });
    const body = JSON.parse(calls[0].init.body);
    expect(body.spec_snapshot).toMatchObject({ scanner: 'missing-test-scanner', repair_kind: 'write_test', source: 'learn-outcomes' });
    expect(body.auto_exec_eligible).toBe(true);
    expect(Object.keys(body)).not.toContain('repair_kind');
  });

  it('the allocate route goes through it (one insert path)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/test-contracts-missing.ts'), 'utf8');
    expect(src).toContain('const recInsertResp = await insertMissingTestRecommendation({');
    expect(src.match(/rest\/v1\/autopilot_recommendations/g)).toHaveLength(1);
  });
});
