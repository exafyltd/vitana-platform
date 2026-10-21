/**
 * VTID-04309 — GET /api/v1/operator/threads/:threadId/messages is mounted on
 * the real app (JSON, not an Express HTML 404) and requires a verified
 * exafy_admin caller.
 */
jest.mock('node-fetch');
import request from 'supertest';
import app from '../src/index';

const THREAD = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('GET /api/v1/operator/threads/:threadId/messages', () => {
  it('is mounted and refuses a caller without a token with a JSON 401', async () => {
    const res = await request(app).get(`/api/v1/operator/threads/${THREAD}/messages`);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
  });

  it('refuses a forged token with a JSON 401', async () => {
    const res = await request(app)
      .get(`/api/v1/operator/threads/${THREAD}/messages`)
      .set('Authorization', 'Bearer header.eyJzdWIiOiJ4In0.sig');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
