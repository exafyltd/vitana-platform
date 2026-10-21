/**
 * VTID-05103 — GET /api/v1/routines/runner/status (exafy_admin only, read-only)
 * and the ALERT-* workflows reporting into the self-healing intake.
 */
import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';

let identity: any;
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = identity;
    return next();
  },
  requireExafyAdmin: (req: any, res: any, next: any) =>
    req.identity?.exafy_admin ? next() : res.status(403).json({ ok: false, error: 'FORBIDDEN' }),
}));

function app() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { routinesRouter } = require('../../src/routes/routines');
  const a = express();
  a.use('/', routinesRouter);
  return a;
}

describe('GET /api/v1/routines/runner/status', () => {
  beforeEach(() => {
    identity = null;
    process.env.SUPABASE_URL = 'https://supa.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc';
    const rows = [{ name: 'agents-heartbeat', enabled: true, last_run_status: 'success' }];
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => rows,
      text: async () => JSON.stringify(rows),
    }));
  });

  it('401 without a sign-in', async () => {
    const res = await request(app()).get('/api/v1/routines/runner/status');
    expect(res.status).toBe(401);
  });

  it('403 for a non-admin', async () => {
    identity = { exafy_admin: false };
    const res = await request(app()).get('/api/v1/routines/runner/status');
    expect(res.status).toBe(403);
  });

  it('exafy_admin sees the 14 routines, their times and catalog rows', async () => {
    identity = { exafy_admin: true };
    const res = await request(app()).get('/api/v1/routines/runner/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.routines).toHaveLength(14);
    const hb = res.body.routines.find((r: any) => r.name === 'agents-heartbeat');
    expect(hb).toMatchObject({ run_at_utc: '05:30', catalog: { enabled: true, last_run_status: 'success' } });
  });

  it('does not shadow GET /api/v1/routines/:name', async () => {
    identity = null;
    const res = await request(app()).get('/api/v1/routines/agents-heartbeat');
    expect(res.status).not.toBe(401);
  });
});

describe('ALERT-* workflows report a failure into the self-healing intake', () => {
  const dir = path.resolve(__dirname, '../../../../.github/workflows');
  const alerts = fs.readdirSync(dir).filter((f) => /^ALERT-.*\.yml$/.test(f));

  it('there are 7 ALERT workflows', () => expect(alerts).toHaveLength(7));

  it.each(alerts)('%s runs the report script on failure only', (f) => {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    const wf = f.replace(/\.yml$/, '');
    expect(s).toMatch(/- name: Check out the report script\n\s+if: failure\(\)/);
    expect(s).toMatch(/- name: Report failure to self-healing\n\s+if: failure\(\)/);
    expect(s).toContain('SERVICE_TOKEN: ${{ secrets.GATEWAY_SERVICE_TOKEN }}');
    expect(s).toContain(`bash scripts/ci/report-to-self-healing.sh "${wf.toLowerCase()}" "alert-workflow://${wf}"`);
  });

  it('the report script posts the E2E-ORB-MONITOR request shape and never fails the step', () => {
    const s = fs.readFileSync(path.resolve(__dirname, '../../../../scripts/ci/report-to-self-healing.sh'), 'utf8');
    expect(s).toContain('/api/v1/self-healing/report');
    expect(s).toContain('status: "down"');
    expect(s).toContain('|| echo "::warning::Self-healing report POST failed (non-fatal)"');
    expect(s.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('production deploy pins ROUTINE_RUNNER_ENABLED=true', () => {
    const s = fs.readFileSync(path.join(dir, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    expect(s).toContain('{name:"ROUTINE_RUNNER_ENABLED", value:"true"}');
  });
});
