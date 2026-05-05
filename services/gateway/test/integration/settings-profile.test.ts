import request from 'supertest';
import express from 'express';
import settingsRouter from '../../../src/routes/settings';
import { getSupabase } from '../../../src/lib/supabase';

// Mock dependencies
jest.mock('../../../src/lib/supabase');
jest.mock('../../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn((req, res, next) => {
    req.identity = { user_id: 'test-user-id' };
    next();
  }),
}));

describe('Settings Profile Integration Test', () => {
  let app: express.Express;

  const mockSingle = jest.fn();
  const mockSelect = jest.fn(() => ({ single: mockSingle }));
  const mockUpsert = jest.fn(() => ({ select: mockSelect }));
  const mockFrom = jest.fn(() => ({ upsert: mockUpsert }));

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/settings', settingsRouter);

    (getSupabase as jest.Mock).mockReturnValue({
      from: mockFrom
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates first name with provenance_source: user_stated_via_settings', async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: 'fact-1' }, error: null });

    const response = await request(app)
      .patch('/settings/profile')
      .send({ first_name: 'Alice' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    expect(mockFrom).toHaveBeenCalledWith('memory_facts');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'test-user-id',
        fact_key: 'user_first_name',
        fact_value: 'Alice',
        provenance_source: 'user_stated_via_settings',
      }),
      expect.anything()
    );
  });

  it('updates nickname with provenance_source: user_stated_via_settings', async () => {
    mockSingle.mockResolvedValueOnce({ data: { id: 'fact-2' }, error: null });

    const response = await request(app)
      .patch('/settings/profile')
      .send({ nickname: 'Ali' });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'test-user-id',
        fact_key: 'user_nickname',
        fact_value: 'Ali',
        provenance_source: 'user_stated_via_settings',
      }),
      expect.anything()
    );
  });

  it('returns error on invalid payload structure (zod check)', async () => {
    const response = await request(app)
      .patch('/settings/profile')
      .send({ first_name: 1234 });

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toBe('invalid payload');
  });

  it('returns error if db write fails', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'Database failure' } });

    const response = await request(app)
      .patch('/settings/profile')
      .send({ first_name: 'Alice' });

    expect(response.status).toBe(500);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toBe('Database failure');
  });
});