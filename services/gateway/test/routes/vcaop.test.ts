/**
 * VCAOP gateway routes (src/routes/vcaop.ts) — swallowed-Supabase-error fixes
 * (BOOTSTRAP-AURORA-CUTOVER). Four .maybeSingle()/select() call sites used to
 * discard `error`, letting a real DB failure masquerade as a legitimate
 * empty/not-found result:
 *  - POST /affiliate-link: fetchAffiliateProgramById -> 404 (now 500 on error)
 *  - POST /commissions/:id/confirm: fetchCommissionEventById -> 404 (now 500)
 *  - POST /tasks/:id/complete: fetchHumanTaskById -> 404 (now 500)
 *  - POST /onboarding/batch: fetchProvidersForOnboarding -> silent empty
 *    "success" (now 500)
 */
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({ requireAuth: jest.fn() }));
jest.mock('../../src/lib/supabase', () => ({ getSupabase: jest.fn(() => ({})) }));

const mockFetchAffiliateProgramById = jest.fn();
const mockUpsertSubidMap = jest.fn();
const mockFetchCommissionEventById = jest.fn();
const mockUpdateCommissionEventConfirmed = jest.fn();
const mockUpdateRewardsLedgerConfirmedByCommission = jest.fn();
const mockFetchProvidersForOnboarding = jest.fn();
const mockInsertProviderAccountRows = jest.fn();
const mockInsertProvisioningJobRows = jest.fn();
const mockInsertHumanTaskRows = jest.fn();
const mockFetchHumanTaskById = jest.fn();
const mockUpdateHumanTaskCompleted = jest.fn();
const mockUpdateProvisioningJobRunning = jest.fn();
const mockInsertOasisEvent = jest.fn();

jest.mock('../../src/routes/vcaop-repository', () => ({
  fetchAffiliateProgramById: (...args: unknown[]) => mockFetchAffiliateProgramById(...args),
  upsertSubidMap: (...args: unknown[]) => mockUpsertSubidMap(...args),
  fetchCommissionEventById: (...args: unknown[]) => mockFetchCommissionEventById(...args),
  updateCommissionEventConfirmed: (...args: unknown[]) => mockUpdateCommissionEventConfirmed(...args),
  updateRewardsLedgerConfirmedByCommission: (...args: unknown[]) => mockUpdateRewardsLedgerConfirmedByCommission(...args),
  fetchProvidersForOnboarding: (...args: unknown[]) => mockFetchProvidersForOnboarding(...args),
  insertProviderAccountRows: (...args: unknown[]) => mockInsertProviderAccountRows(...args),
  insertProvisioningJobRows: (...args: unknown[]) => mockInsertProvisioningJobRows(...args),
  insertHumanTaskRows: (...args: unknown[]) => mockInsertHumanTaskRows(...args),
  fetchHumanTaskById: (...args: unknown[]) => mockFetchHumanTaskById(...args),
  updateHumanTaskCompleted: (...args: unknown[]) => mockUpdateHumanTaskCompleted(...args),
  updateProvisioningJobRunning: (...args: unknown[]) => mockUpdateProvisioningJobRunning(...args),
  insertOasisEvent: (...args: unknown[]) => mockInsertOasisEvent(...args),
}));

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import vcaopRouter from '../../src/routes/vcaop';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';

const app = express();
app.use(express.json());
app.use('/api/v1/vcaop', vcaopRouter);

const asAdmin = () =>
  (requireAuth as jest.Mock).mockImplementation((req: any, _res: Response, next: NextFunction) => {
    req.identity = { user_id: 'admin-1', tenant_id: 'platform', exafy_admin: true };
    next();
  });
const asCommunity = () =>
  (requireAuth as jest.Mock).mockImplementation((req: any, _res: Response, next: NextFunction) => {
    req.identity = { user_id: 'user-1', tenant_id: 'platform', exafy_admin: false };
    next();
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockInsertOasisEvent.mockResolvedValue({ error: null });
});

describe('POST /affiliate-link — fetchAffiliateProgramById error handling', () => {
  beforeEach(() => asCommunity());

  test('a real DB error responds 500 (not the misleading 404)', async () => {
    mockFetchAffiliateProgramById.mockResolvedValue({ data: null, error: { message: 'connection terminated unexpectedly' } });

    const res = await request(app)
      .post('/api/v1/vcaop/affiliate-link')
      .send({ affiliateProgramId: 'prog-1' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'connection terminated unexpectedly' });
    expect(mockUpsertSubidMap).not.toHaveBeenCalled();
  });

  test('a genuinely missing program (no error) still 404s — unchanged', async () => {
    mockFetchAffiliateProgramById.mockResolvedValue({ data: null, error: null });

    const res = await request(app)
      .post('/api/v1/vcaop/affiliate-link')
      .send({ affiliateProgramId: 'prog-1' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'program not found' });
  });

  test('a found program still registers the subid map and returns the link — unchanged', async () => {
    mockFetchAffiliateProgramById.mockResolvedValue({
      data: { id: 'prog-1', network: 'admitad', policy: { gotolink: 'https://x.example/go' }, affiliate_cashback_allowed: true },
      error: null,
    });
    mockUpsertSubidMap.mockResolvedValue({ error: null });

    const res = await request(app)
      .post('/api/v1/vcaop/affiliate-link')
      .send({ affiliateProgramId: 'prog-1' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockUpsertSubidMap).toHaveBeenCalledTimes(1);
  });
});

describe('POST /commissions/:id/confirm — fetchCommissionEventById error handling', () => {
  beforeEach(() => asAdmin());

  test('a real DB error responds 500 (not the misleading 404) — money-moving path', async () => {
    mockFetchCommissionEventById.mockResolvedValue({ data: null, error: { message: 'timeout' } });

    const res = await request(app)
      .post('/api/v1/vcaop/commissions/comm-1/confirm')
      .send({ postbackRef: 'ref-1' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'timeout' });
    expect(mockUpdateCommissionEventConfirmed).not.toHaveBeenCalled();
    expect(mockUpdateRewardsLedgerConfirmedByCommission).not.toHaveBeenCalled();
  });

  test('a genuinely missing commission (no error) still 404s — unchanged', async () => {
    mockFetchCommissionEventById.mockResolvedValue({ data: null, error: null });

    const res = await request(app)
      .post('/api/v1/vcaop/commissions/comm-1/confirm')
      .send({ postbackRef: 'ref-1' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'commission not found' });
  });

  test('a pending commission still confirms — unchanged', async () => {
    mockFetchCommissionEventById.mockResolvedValue({ data: { id: 'comm-1', status: 'pending' }, error: null });
    mockUpdateCommissionEventConfirmed.mockResolvedValue({ error: null });
    mockUpdateRewardsLedgerConfirmedByCommission.mockResolvedValue({ error: null });

    const res = await request(app)
      .post('/api/v1/vcaop/commissions/comm-1/confirm')
      .send({ postbackRef: 'ref-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('non-admin gets 403 regardless of DB state — unchanged', async () => {
    asCommunity();
    const res = await request(app)
      .post('/api/v1/vcaop/commissions/comm-1/confirm')
      .send({ postbackRef: 'ref-1' });
    expect(res.status).toBe(403);
    expect(mockFetchCommissionEventById).not.toHaveBeenCalled();
  });
});

describe('POST /tasks/:id/complete — fetchHumanTaskById error handling', () => {
  beforeEach(() => asAdmin());

  test('a real DB error responds 500 (not the misleading 404)', async () => {
    mockFetchHumanTaskById.mockResolvedValue({ data: null, error: { message: 'connection refused' } });

    const res = await request(app).post('/api/v1/vcaop/tasks/task-1/complete').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'connection refused' });
    expect(mockUpdateHumanTaskCompleted).not.toHaveBeenCalled();
  });

  test('a genuinely missing task (no error) still 404s — unchanged', async () => {
    mockFetchHumanTaskById.mockResolvedValue({ data: null, error: null });

    const res = await request(app).post('/api/v1/vcaop/tasks/task-1/complete').send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'task not found' });
  });

  test('a found task still completes — unchanged', async () => {
    mockFetchHumanTaskById.mockResolvedValue({ data: { id: 'task-1', type: 'KYB', job_id: 'job-1' }, error: null });
    mockUpdateHumanTaskCompleted.mockResolvedValue({ error: null });
    mockUpdateProvisioningJobRunning.mockResolvedValue({ error: null });

    const res = await request(app).post('/api/v1/vcaop/tasks/task-1/complete').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockUpdateProvisioningJobRunning).toHaveBeenCalledWith(expect.anything(), 'job-1', expect.any(String));
  });
});

describe('POST /onboarding/batch — fetchProvidersForOnboarding error handling', () => {
  beforeEach(() => asAdmin());

  test('a real DB error responds 500 instead of a silent empty-success {queued:0}', async () => {
    mockFetchProvidersForOnboarding.mockResolvedValue({ data: null, error: { message: 'connection terminated unexpectedly' } });

    const res = await request(app)
      .post('/api/v1/vcaop/onboarding/batch')
      .send({ providerIds: ['prov-1', 'prov-2'] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'connection terminated unexpectedly' });
    expect(mockInsertProviderAccountRows).not.toHaveBeenCalled();
    expect(mockInsertOasisEvent).not.toHaveBeenCalled();
  });

  test('an empty (but error-free) provider list still returns a genuine empty success — unchanged', async () => {
    mockFetchProvidersForOnboarding.mockResolvedValue({ data: [], error: null });

    const res = await request(app)
      .post('/api/v1/vcaop/onboarding/batch')
      .send({ providerIds: [] });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, data: { queued: 0, humanTasksCreated: 0 } });
  });

  test('a real provider batch still queues rows and tasks — unchanged', async () => {
    mockFetchProvidersForOnboarding.mockResolvedValue({
      data: [{ id: 'prov-1', connector_mode: 'ucp', kyb_required: true }],
      error: null,
    });
    mockInsertProviderAccountRows.mockResolvedValue({ error: null });
    mockInsertProvisioningJobRows.mockResolvedValue({ error: null });
    mockInsertHumanTaskRows.mockResolvedValue({ error: null });

    const res = await request(app)
      .post('/api/v1/vcaop/onboarding/batch')
      .send({ providerIds: ['prov-1'] });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, data: { queued: 1, humanTasksCreated: 2 } });
  });
});
