/**
 * VTID-04210 — GET /api/v1/operator/health now reports which OPTIONAL
 * Operator Console capabilities are live, as booleans, so an operator (or
 * a monitoring check) doesn't have to check six env vars separately.
 *
 * No auth on this route (unchanged) and no secret values are ever
 * exposed — every value is a boolean derived from an env var equality
 * check. Each predicate (`isOperatorThreadsEnabled()` etc.) reads
 * `process.env` fresh on every call, so this test mutates `process.env`
 * directly around each request against a single, real, already-imported
 * app — no module reset needed.
 */

import request from 'supertest';
import app from '../src/index';

const ENV_KEYS = [
  'OPERATOR_THREADS_ENABLED',
  'OPERATOR_TURN_MEMORY_ENABLED',
  'OPERATOR_SQL_READONLY_ENABLED',
  'OPERATOR_AWS_READONLY_ENABLED',
  'OPERATOR_BOOTSTRAP_PACK_ENABLED',
  'OPERATOR_VTID_SELF_ALLOCATE_ENABLED',
] as const;

const originalEnv: Record<string, string | undefined> = {};

describe('VTID-04210 GET /api/v1/operator/health — capabilities', () => {
  beforeAll(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('reports every flag false when none of the env vars are set', async () => {
    const res = await request(app).get('/api/v1/operator/health').expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      service: 'operator-api',
      status: 'healthy',
      capabilities: {
        threads: false,
        turn_memory: false,
        sql_readonly: false,
        aws_readonly: false,
        bootstrap_pack: false,
        vtid_self_allocate: false,
      },
    });
  });

  it('reports every flag true when every env var is the exact string "true"', async () => {
    for (const k of ENV_KEYS) process.env[k] = 'true';
    const res = await request(app).get('/api/v1/operator/health').expect(200);
    expect(res.body.capabilities).toEqual({
      threads: true,
      turn_memory: true,
      sql_readonly: true,
      aws_readonly: true,
      bootstrap_pack: true,
      vtid_self_allocate: true,
    });
  });

  it('reflects a mixed on/off state independently per flag', async () => {
    process.env.OPERATOR_THREADS_ENABLED = 'true';
    process.env.OPERATOR_SQL_READONLY_ENABLED = 'true';
    // OPERATOR_TURN_MEMORY_ENABLED / OPERATOR_AWS_READONLY_ENABLED /
    // OPERATOR_BOOTSTRAP_PACK_ENABLED / OPERATOR_VTID_SELF_ALLOCATE_ENABLED
    // left unset.
    const res = await request(app).get('/api/v1/operator/health').expect(200);
    expect(res.body.capabilities).toEqual({
      threads: true,
      turn_memory: false,
      sql_readonly: true,
      aws_readonly: false,
      bootstrap_pack: false,
      vtid_self_allocate: false,
    });
  });

  it('treats any value other than the exact string "true" as off (e.g. "1", "TRUE")', async () => {
    process.env.OPERATOR_THREADS_ENABLED = '1';
    process.env.OPERATOR_TURN_MEMORY_ENABLED = 'TRUE';
    const res = await request(app).get('/api/v1/operator/health').expect(200);
    expect(res.body.capabilities.threads).toBe(false);
    expect(res.body.capabilities.turn_memory).toBe(false);
  });

  it('requires no authentication', async () => {
    // No Authorization header, no x-operator-role — must still succeed.
    await request(app).get('/api/v1/operator/health').expect(200);
  });

  it('exposes no secret values — every capabilities value is a plain boolean', async () => {
    for (const k of ENV_KEYS) process.env[k] = 'true';
    const res = await request(app).get('/api/v1/operator/health').expect(200);
    for (const v of Object.values(res.body.capabilities)) {
      expect(typeof v).toBe('boolean');
    }
  });

  it('preserves the pre-existing response fields unchanged', async () => {
    const res = await request(app).get('/api/v1/operator/health').expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('operator-api');
    expect(res.body.status).toBe('healthy');
    expect(res.body.vtid).toBe('VTID-0509');
    expect(typeof res.body.timestamp).toBe('string');
  });
});
