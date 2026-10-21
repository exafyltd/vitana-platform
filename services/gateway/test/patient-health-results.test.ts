// VTID-03939 — HTTP tests for GET /api/v1/patient/health-results.
//
// Contract under test:
//   - 401 with no Bearer token
//   - happy path: lab_reports joined to biomarker_results, org attribution
//     resolved for partner-sourced rows, null for self-uploaded rows
//   - graceful degradation: a "column does not exist" error on the
//     VTID-03932-only columns (assigned_professional_user_id,
//     partner_organization_id) retries narrower and still returns 200
//     rather than failing the whole request

import express from 'express';
import request from 'supertest';

jest.mock('../src/lib/supabase-user');

import { createUserSupabaseClient } from '../src/lib/supabase-user';

const mockCreateUserSupabaseClient = createUserSupabaseClient as jest.MockedFunction<typeof createUserSupabaseClient>;

type TableHandler = (ctx: { selectArgs: any[] }) => { data: any; error: any };
let tableHandlers: Record<string, TableHandler>;
let meContextResult: { data: any; error: any };

function makeFakeUserSupabase() {
  return {
    rpc: (name: string) => {
      if (name === 'me_context') return Promise.resolve(meContextResult);
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const handler = tableHandlers[table];
      if (!handler) throw new Error(`Unexpected table in test: ${table}`);
      let selectArgs: any[] = [];
      const chain: any = {};
      chain.select = (...args: any[]) => { selectArgs = args; return chain; };
      for (const m of ['eq', 'in', 'order']) {
        chain[m] = (..._args: any[]) => chain;
      }
      chain.then = (resolve: any, reject: any) =>
        Promise.resolve(handler({ selectArgs })).then(resolve, reject);
      return chain;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/patient-health-results').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/patient', router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  tableHandlers = {};
  meContextResult = { data: { user_id: 'u1', tenant_id: 't1' }, error: null };
  mockCreateUserSupabaseClient.mockReturnValue(makeFakeUserSupabase() as any);
});

describe('GET /health-results — auth', () => {
  it('401 with no Bearer token', async () => {
    const r = await request(makeApp()).get('/api/v1/patient/health-results');
    expect(r.status).toBe(401);
    expect(r.type).toBe('application/json');
  });
});

describe('GET /health-results — happy path', () => {
  it('resolves org attribution for a partner-sourced report and leaves a self-uploaded report org: null', async () => {
    tableHandlers.lab_reports = () => ({
      data: [
        {
          id: 'lr-1', report_date: '2026-09-01', source: 'partner:doctorbox', created_at: '2026-09-01T00:00:00Z',
          partner_result_id: 'phr-1',
          biomarker_results: [{ id: 'b-1', biomarker_code: 'hba1c', name: 'HbA1c', value: 5.4, unit: '%', ref_range_low: 4, ref_range_high: 5.6, status: 'normal', measured_at: '2026-09-01T00:00:00Z' }],
        },
        {
          id: 'lr-2', report_date: '2026-08-01', source: null, created_at: '2026-08-01T00:00:00Z',
          partner_result_id: null,
          biomarker_results: [],
        },
      ],
      error: null,
    });
    tableHandlers.partner_health_results = () => ({ data: [{ id: 'phr-1', order_id: 'order-1' }], error: null });
    tableHandlers.partner_health_test_orders = () => ({ data: [{ id: 'order-1', partner_id: 'partner-1', assigned_professional_user_id: null }], error: null });
    tableHandlers.partner_registry = () => ({ data: [{ id: 'partner-1', display_name: 'DoctorBox', partner_organization_id: null }], error: null });

    const r = await request(makeApp()).get('/api/v1/patient/health-results').set('Authorization', 'Bearer u1');
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(2);

    const lr1 = r.body.results.find((x: any) => x.id === 'lr-1');
    expect(lr1.org).toEqual({ display_name: 'DoctorBox', self_registered_name: null, professional_user_id: null });
    expect(lr1.biomarkers).toHaveLength(1);
    expect(lr1.biomarkers[0].biomarker_code).toBe('hba1c');

    const lr2 = r.body.results.find((x: any) => x.id === 'lr-2');
    expect(lr2.org).toBeNull();
    expect(lr2.biomarkers).toHaveLength(0);
  });

  it('returns an empty list, not an error, when the caller has no reports', async () => {
    tableHandlers.lab_reports = () => ({ data: [], error: null });
    const r = await request(makeApp()).get('/api/v1/patient/health-results').set('Authorization', 'Bearer u1');
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([]);
  });
});

describe('GET /health-results — graceful degradation pre-VTID-03932 migration', () => {
  it('retries without assigned_professional_user_id/partner_organization_id on a column-does-not-exist error, and still returns 200', async () => {
    tableHandlers.lab_reports = () => ({
      data: [{ id: 'lr-1', report_date: '2026-09-01', source: 'partner:doctorbox', created_at: '2026-09-01T00:00:00Z', partner_result_id: 'phr-1', biomarker_results: [] }],
      error: null,
    });
    tableHandlers.partner_health_results = () => ({ data: [{ id: 'phr-1', order_id: 'order-1' }], error: null });

    tableHandlers.partner_health_test_orders = ({ selectArgs }) => {
      if (String(selectArgs[0]).includes('assigned_professional_user_id')) {
        return { data: null, error: { message: 'column "assigned_professional_user_id" does not exist' } };
      }
      return { data: [{ id: 'order-1', partner_id: 'partner-1' }], error: null };
    };
    tableHandlers.partner_registry = ({ selectArgs }) => {
      if (String(selectArgs[0]).includes('partner_organization_id')) {
        return { data: null, error: { message: 'column "partner_organization_id" does not exist' } };
      }
      return { data: [{ id: 'partner-1', display_name: 'DoctorBox' }], error: null };
    };

    const r = await request(makeApp()).get('/api/v1/patient/health-results').set('Authorization', 'Bearer u1');
    expect(r.status).toBe(200);
    expect(r.body.results).toHaveLength(1);
    expect(r.body.results[0].org).toEqual({ display_name: 'DoctorBox', self_registered_name: null, professional_user_id: null });
  });

  it('degrades to org: null (not a 500) when partner_health_results itself errors', async () => {
    tableHandlers.lab_reports = () => ({
      data: [{ id: 'lr-1', report_date: '2026-09-01', source: 'partner:doctorbox', created_at: '2026-09-01T00:00:00Z', partner_result_id: 'phr-1', biomarker_results: [] }],
      error: null,
    });
    tableHandlers.partner_health_results = () => ({ data: null, error: { message: 'boom' } });

    const r = await request(makeApp()).get('/api/v1/patient/health-results').set('Authorization', 'Bearer u1');
    expect(r.status).toBe(200);
    expect(r.body.results[0].org).toBeNull();
  });
});

describe('GET /health-results — auth context errors', () => {
  it('401 when me_context reports a JWT/auth error', async () => {
    meContextResult = { data: null, error: { message: 'invalid JWT' } };
    const r = await request(makeApp()).get('/api/v1/patient/health-results').set('Authorization', 'Bearer bad-token');
    expect(r.status).toBe(401);
  });

  it('500 when lab_reports itself errors', async () => {
    tableHandlers.lab_reports = () => ({ data: null, error: { message: 'db down' } });
    const r = await request(makeApp()).get('/api/v1/patient/health-results').set('Authorization', 'Bearer u1');
    expect(r.status).toBe(500);
  });
});
