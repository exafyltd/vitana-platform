/**
 * routes/ai-assistants.ts — POST /apikey/:provider previously destructured
 * only `{ data: existing }` from fetchExistingApiKeyConnection(), discarding
 * the error. On a real DB error, `existing` is `undefined`, and the handler
 * took the INSERT branch even though a connection row may already exist
 * for this tenant/user/provider — creating a duplicate `user_connections`
 * row (and duplicate encrypted-credential row) instead of updating the
 * existing one, or surfacing an opaque failure from a unique-constraint
 * violation instead of the clean update path.
 *
 * This pins that a real lookup error now returns a clean 500 instead of
 * silently falling through to the insert branch.
 */

import express, { Response, NextFunction } from 'express';
import request from 'supertest';
import aiAssistantsRouter from '../../src/routes/ai-assistants';
import { requireAuth } from '../../src/middleware/auth-supabase-jwt';
import { getSupabase } from '../../src/lib/supabase';

jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: jest.fn(),
}));

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: jest.fn(),
}));

const mockFetchProviderPolicy = jest.fn();
const mockFetchExistingApiKeyConnection = jest.fn();
const mockUpdateAiConnection = jest.fn();
const mockInsertAiConnection = jest.fn();
const mockUpsertAiCredentials = jest.fn();

jest.mock('../../src/services/ai-assistants/ai-assistants-repository', () => ({
  fetchProviderPolicy: (...args: unknown[]) => mockFetchProviderPolicy(...args),
  fetchExistingApiKeyConnection: (...args: unknown[]) => mockFetchExistingApiKeyConnection(...args),
  updateAiConnection: (...args: unknown[]) => mockUpdateAiConnection(...args),
  insertAiConnection: (...args: unknown[]) => mockInsertAiConnection(...args),
  upsertAiCredentials: (...args: unknown[]) => mockUpsertAiCredentials(...args),
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const app = express();
app.use(express.json());
app.use('/api/v1/integrations/ai-assistants', aiAssistantsRouter);

describe('POST /apikey/:provider — fetchExistingApiKeyConnection error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AI_CREDENTIALS_ENC_KEY = '0'.repeat(64);
    (requireAuth as jest.Mock).mockImplementation((req: any, res: Response, next: NextFunction) => {
      req.identity = { user_id: 'user-1', tenant_id: 'tenant-1', exafy_admin: false, role: null, email: 't@e.com' };
      next();
    });
    (getSupabase as jest.Mock).mockReturnValue({});
    mockFetchProviderPolicy.mockResolvedValue({ data: { allowed: true }, error: null });
  });

  it('returns 500 and does NOT attempt an insert when the existing-connection lookup errors', async () => {
    mockFetchExistingApiKeyConnection.mockResolvedValue({
      data: null,
      error: { message: 'connection reset' },
    });

    const response = await request(app)
      .post('/api/v1/integrations/ai-assistants/apikey/chatgpt')
      .send({ api_key: 'sk-1234567890' });

    expect(response.status).toBe(500);
    expect(mockInsertAiConnection).not.toHaveBeenCalled();
    expect(mockUpdateAiConnection).not.toHaveBeenCalled();
  });

  it('takes the insert branch on a successful lookup finding no existing connection', async () => {
    mockFetchExistingApiKeyConnection.mockResolvedValue({ data: null, error: null });
    mockInsertAiConnection.mockResolvedValue({ data: { id: 'conn-1' }, error: null });
    mockUpsertAiCredentials.mockResolvedValue({ error: null });

    const response = await request(app)
      .post('/api/v1/integrations/ai-assistants/apikey/chatgpt')
      .send({ api_key: 'sk-1234567890' });

    expect(mockInsertAiConnection).toHaveBeenCalledTimes(1);
    expect(response.status).not.toBe(500);
  });
});
