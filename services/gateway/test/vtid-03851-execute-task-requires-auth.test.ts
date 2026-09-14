/**
 * VTID-03851 — autopilot_execute_task requires an authenticated exafy_admin
 * session.
 *
 * Observed on staging 2026-09-13: POST /api/v1/operator/chat accepted a
 * request with no Authorization header, and with
 * OPERATOR_EXECUTION_ONRAMP_ENABLED=true that request could reach
 * autopilot_execute_task — a tool that queues a real code execution and
 * opens a pull request against this repo.
 *
 * Two halves, both pinned:
 *   1. The pure authz module (operator-execute-authz.ts): set/clear/get
 *      semantics and the predicate, including the client-supplied-threadId
 *      threat (an anonymous request must NOT inherit an admin's marker).
 *   2. Source wiring: the /chat route runs optionalAuth and writes the
 *      marker on every request; executeExecuteTask() refuses BEFORE
 *      governance/OASIS/DB work.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  setThreadAuth,
  clearThreadAuth,
  getThreadAuth,
  isExecuteTaskAuthorized,
  describeExecuteTaskRefusal,
} from '../src/services/operator-execute-authz';

const SRC = path.resolve(__dirname, '../src');
const operatorRoute = fs.readFileSync(path.join(SRC, 'routes/operator.ts'), 'utf8');
const geminiOperator = fs.readFileSync(path.join(SRC, 'services/gemini-operator.ts'), 'utf8');

describe('VTID-03851 — isExecuteTaskAuthorized (pure)', () => {
  it('refuses when no marker exists (anonymous request)', () => {
    expect(isExecuteTaskAuthorized(undefined)).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('refuses an empty / non-string user_id', () => {
    expect(isExecuteTaskAuthorized({ user_id: '', exafy_admin: true })).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(isExecuteTaskAuthorized({ user_id: 42 as unknown as string, exafy_admin: true })).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('refuses an authenticated non-admin', () => {
    expect(isExecuteTaskAuthorized({ user_id: 'u-1', exafy_admin: false })).toEqual({ ok: false, reason: 'not_admin' });
    // truthy-but-not-true must not pass
    expect(isExecuteTaskAuthorized({ user_id: 'u-1', exafy_admin: 'true' as unknown as boolean })).toEqual({ ok: false, reason: 'not_admin' });
  });

  it('allows a verified exafy_admin', () => {
    expect(isExecuteTaskAuthorized({ user_id: 'u-1', exafy_admin: true })).toEqual({ ok: true });
  });

  it('refusal text names the VTID and says no execution was queued', () => {
    expect(describeExecuteTaskRefusal('unauthenticated')).toMatch(/no valid Authorization bearer token/);
    expect(describeExecuteTaskRefusal('not_admin')).toMatch(/not an exafy admin/);
    expect(describeExecuteTaskRefusal('unauthenticated')).toMatch(/VTID-03851/);
    expect(describeExecuteTaskRefusal('not_admin')).toMatch(/no execution was queued/);
  });
});

describe('VTID-03851 — thread marker semantics', () => {
  afterEach(() => {
    clearThreadAuth('t-admin');
    clearThreadAuth('t-other');
  });

  it('set → get round-trips and normalises exafy_admin to a strict boolean', () => {
    setThreadAuth('t-admin', { user_id: 'u-1', exafy_admin: true });
    expect(getThreadAuth('t-admin')).toEqual({ user_id: 'u-1', exafy_admin: true });
    setThreadAuth('t-other', { user_id: 'u-2', exafy_admin: 'yes' as unknown as boolean });
    expect(getThreadAuth('t-other')).toEqual({ user_id: 'u-2', exafy_admin: false });
  });

  it('the threat this exists for: an anonymous request on a reused threadId clears the admin marker', () => {
    setThreadAuth('t-admin', { user_id: 'u-1', exafy_admin: true });
    expect(isExecuteTaskAuthorized(getThreadAuth('t-admin'))).toEqual({ ok: true });
    // second request, same client-supplied threadId, no JWT → route calls clear
    clearThreadAuth('t-admin');
    expect(isExecuteTaskAuthorized(getThreadAuth('t-admin'))).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('a non-admin request on a reused threadId overwrites, never keeps, the admin marker', () => {
    setThreadAuth('t-admin', { user_id: 'u-1', exafy_admin: true });
    setThreadAuth('t-admin', { user_id: 'u-9', exafy_admin: false });
    expect(isExecuteTaskAuthorized(getThreadAuth('t-admin'))).toEqual({ ok: false, reason: 'not_admin' });
  });

  it('clearing an unknown thread is a no-op', () => {
    expect(() => clearThreadAuth('never-set')).not.toThrow();
    expect(getThreadAuth('never-set')).toBeUndefined();
  });
});

describe('VTID-03851 — source wiring', () => {
  it('/chat runs optionalAuth (never requireAuth — anonymous chat stays allowed)', () => {
    expect(operatorRoute).toMatch(/router\.post\('\/chat', optionalAuth, async/);
    expect(operatorRoute).toMatch(/import \{ requireAdminAuth, optionalAuth, AuthenticatedRequest \} from '\.\.\/middleware\/auth-supabase-jwt'/);
  });

  it('/chat writes the marker on EVERY request: set on a verified identity, clear otherwise', () => {
    const route = operatorRoute.slice(operatorRoute.indexOf("router.post('/chat'"));
    const handler = route.slice(0, route.indexOf('processWithGemini({'));
    expect(handler).toMatch(/const callerIdentity = \(req as AuthenticatedRequest\)\.identity;/);
    expect(handler).toMatch(/setThreadAuth\(threadId, \{ user_id: callerIdentity\.user_id, exafy_admin: callerIdentity\.exafy_admin === true \}\)/);
    expect(handler).toMatch(/\} else \{\s*clearThreadAuth\(threadId\);\s*\}/);
    // the marker is written before the LLM turn that can call the tool
    expect(handler.indexOf('setThreadAuth(')).toBeGreaterThan(-1);
  });

  it('executeExecuteTask refuses before governance, OASIS, or any on-ramp call', () => {
    const fn = geminiOperator.slice(geminiOperator.indexOf('async function executeExecuteTask('));
    const body = fn.slice(0, fn.indexOf('const result = await triggerOperatorExecution('));
    const gate = body.indexOf('isExecuteTaskAuthorized(getThreadAuth(threadId))');
    const governance = body.indexOf("evaluateGovernance('operator.autopilot.execute_task'");
    expect(gate).toBeGreaterThan(-1);
    expect(governance).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(governance);
    expect(body).toMatch(/return \{ ok: false, error: describeExecuteTaskRefusal\(authz\.reason\) \};/);
    expect(body).toMatch(/reason: `auth_\$\{authz\.reason\}`/);
  });

  it('the on-ramp is still reachable for an authorized caller (the gate is an early return, not a removal)', () => {
    const fn = geminiOperator.slice(geminiOperator.indexOf('async function executeExecuteTask('));
    expect(fn).toMatch(/const result = await triggerOperatorExecution\(\{/);
  });
});
