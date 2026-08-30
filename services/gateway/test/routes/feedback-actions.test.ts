/**
 * routes/feedback-actions.ts loadTicketSnapshot() — previously had zero test
 * coverage. Added alongside the 2026-08-30 fix for the swallowed
 * fetchTicketSnapshot error: every admin drafting action (draft-answer,
 * draft-spec, draft-resolution) treated a bare null `data` as "ticket
 * truly doesn't exist" (404 NOT_FOUND) — indistinguishable from a real DB
 * error, which now surfaces as 500 SNAPSHOT_LOOKUP_FAILED instead.
 */

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({})),
}));

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const mockLlmDraftSageAnswer = jest.fn();
const mockLlmDraftDevonSpec = jest.fn();
const mockLlmDraftAtlasResolution = jest.fn();
const mockLlmDraftMiraResolution = jest.fn();
jest.mock('../../src/services/feedback-llm-resolvers', () => ({
  llmDraftSageAnswer: (...args: unknown[]) => mockLlmDraftSageAnswer(...args),
  llmDraftDevonSpec: (...args: unknown[]) => mockLlmDraftDevonSpec(...args),
  llmDraftAtlasResolution: (...args: unknown[]) => mockLlmDraftAtlasResolution(...args),
  llmDraftMiraResolution: (...args: unknown[]) => mockLlmDraftMiraResolution(...args),
}));

const mockFetchTicketSnapshot = jest.fn();
const mockUpdateTicketDraftAnswer = jest.fn();
jest.mock('../../src/routes/feedback-actions-repository', () => ({
  fetchTicketSnapshot: (...args: unknown[]) => mockFetchTicketSnapshot(...args),
  updateTicketDraftAnswer: (...args: unknown[]) => mockUpdateTicketDraftAnswer(...args),
}));

import express from 'express';
import request from 'supertest';
import { adminRouter } from '../../src/routes/feedback-actions';

const app = express();
app.use(express.json());
app.use('/api/v1/admin/feedback', adminRouter);

// header.{"sub":"actor-1"}.sig — decodeJwtSub only reads the middle segment.
const TOKEN = 'h.' + Buffer.from(JSON.stringify({ sub: 'actor-1' })).toString('base64') + '.s';

describe('POST /tickets/:id/draft-answer — loadTicketSnapshot error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 500 SNAPSHOT_LOOKUP_FAILED (not the misleading 404 NOT_FOUND) when the snapshot lookup errors', async () => {
    mockFetchTicketSnapshot.mockResolvedValue({
      data: null,
      error: { message: 'connection terminated unexpectedly' },
    });

    const res = await request(app)
      .post('/api/v1/admin/feedback/tickets/ticket-1/draft-answer')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'SNAPSHOT_LOOKUP_FAILED', details: 'connection terminated unexpectedly' });
    expect(mockLlmDraftSageAnswer).not.toHaveBeenCalled();
    expect(mockUpdateTicketDraftAnswer).not.toHaveBeenCalled();
  });

  it('returns 404 NOT_FOUND for a genuinely missing ticket (no error) — unchanged', async () => {
    mockFetchTicketSnapshot.mockResolvedValue({ data: null, error: null });

    const res = await request(app)
      .post('/api/v1/admin/feedback/tickets/ticket-1/draft-answer')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('drafts successfully when the snapshot is found (unchanged)', async () => {
    mockFetchTicketSnapshot.mockResolvedValue({ data: { id: 'ticket-1', kind: 'bug_report' }, error: null });
    mockLlmDraftSageAnswer.mockResolvedValue({ markdown: 'draft body', provider: 'bedrock' });
    mockUpdateTicketDraftAnswer.mockResolvedValue({ data: { id: 'ticket-1', ticket_number: 42 }, error: null });

    const res = await request(app)
      .post('/api/v1/admin/feedback/tickets/ticket-1/draft-answer')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
