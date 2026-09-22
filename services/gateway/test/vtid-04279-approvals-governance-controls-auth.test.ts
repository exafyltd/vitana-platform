/**
 * VTID-04279 — real exafy_admin auth added to routes/approvals.ts and
 * routes/governance-controls.ts, matching the pattern already used by
 * admin-navigator.ts / feedback-admin.ts / specialists-admin.ts.
 *
 * Behavioral coverage for the two route files lives in
 * test/routes/approvals.test.ts and test/routes/governance-controls.test.ts.
 * Behavioral coverage for the ORB voice tool callers (developer-tools.ts,
 * governance-tools.ts, admin-governance-tools.ts) lives in their own
 * test/orb-tools/*.test.ts files, extended by this VTID to assert a real
 * bearer JWT is forwarded instead of no auth / a spoofable header.
 *
 * This file pins the one remaining internal caller: services/gemini-
 * operator.ts's Operator Console "Developer Assistant" approval tools
 * (dev_list_approvals/dev_approval_count/dev_approve_item/dev_reject_item),
 * which called routes/approvals.ts over HTTP using SUPABASE_SERVICE_ROLE
 * as a bearer token — a real Supabase DB credential, not a user JWT, which
 * requireAdminAuth correctly rejects (valid signature, no exafy_admin
 * claim). Rather than forge/thread a real per-request JWT through this
 * file's args/threadId-only tool dispatcher, these four functions now call
 * services/approvals-service.ts directly (in-process, no HTTP hop, no
 * bearer token needed) — same source-inspection methodology
 * test/vtid-03851-execute-task-requires-auth.test.ts already established
 * for this same file, since gemini-operator.ts is not a route module a
 * request can be built against directly.
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../src');
const geminiOperator = fs.readFileSync(path.join(SRC, 'services/gemini-operator.ts'), 'utf8');

function sliceFunction(source: string, signature: string, nextSignature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const afterStart = source.slice(start);
  const end = afterStart.indexOf(nextSignature);
  expect(end).toBeGreaterThan(-1);
  return afterStart.slice(0, end);
}

describe('VTID-04279 — gemini-operator.ts approval tools no longer use SUPABASE_SERVICE_ROLE as a bearer token', () => {
  it('imports the in-process approvals-service functions', () => {
    expect(geminiOperator).toMatch(
      /import \{\s*getPendingApprovals,\s*getPendingApprovalCount,\s*approveApprovalById,\s*rejectApprovalById,\s*\} from '\.\/approvals-service';/
    );
  });

  const listBody = () => sliceFunction(geminiOperator, 'async function executeDevListApprovals(', 'async function executeDevApprovalCount(');
  const countBody = () => sliceFunction(geminiOperator, 'async function executeDevApprovalCount(', 'async function executeDevApproveItem(');
  const approveBody = () => sliceFunction(geminiOperator, 'async function executeDevApproveItem(', 'async function executeDevRejectItem(');
  const rejectBody = () => sliceFunction(geminiOperator, 'async function executeDevRejectItem(', 'async function executeDevQueryOasisEvents(');

  it('executeDevListApprovals calls getPendingApprovals() directly, not fetch()', () => {
    const body = listBody();
    expect(body).toMatch(/await getPendingApprovals\(limit\)/);
    expect(body).not.toMatch(/fetch\(/);
    // The !SUPABASE_URL || !SUPABASE_SERVICE_ROLE config-presence guard is
    // legitimate and stays — what must be gone is using the key AS a bearer
    // token on an outbound call, which "fetch(" already rules out above.
    expect(body).not.toMatch(/Bearer \$\{SUPABASE_SERVICE_ROLE/);
  });

  it('executeDevApprovalCount calls getPendingApprovalCount() directly, not fetch()', () => {
    const body = countBody();
    expect(body).toMatch(/await getPendingApprovalCount\(\)/);
    expect(body).not.toMatch(/fetch\(/);
    expect(body).not.toMatch(/Bearer \$\{SUPABASE_SERVICE_ROLE/);
  });

  it('executeDevApproveItem calls approveApprovalById() directly, not fetch(), and forwards the resolved thread identity as the decider', () => {
    const body = approveBody();
    expect(body).toMatch(/await approveApprovalById\(args\.approval_id, decidedBy\)/);
    expect(body).not.toMatch(/fetch\(/);
    expect(body).not.toMatch(/SUPABASE_SERVICE_ROLE/);
    expect(body).toMatch(/const decidedBy = getThreadAuth\(threadId\)\?\.user_id \?\? null;/);
  });

  it('executeDevRejectItem calls rejectApprovalById() directly, not fetch(), and forwards the resolved thread identity as the decider', () => {
    const body = rejectBody();
    expect(body).toMatch(/await rejectApprovalById\(args\.approval_id, reason, decidedBy\)/);
    expect(body).not.toMatch(/fetch\(/);
    expect(body).not.toMatch(/SUPABASE_SERVICE_ROLE/);
    expect(body).toMatch(/const decidedBy = getThreadAuth\(threadId\)\?\.user_id \?\? null;/);
  });

  it('executeDevApproveItem and executeDevRejectItem require the SAME verified-exafy_admin gate autopilot_execute_task already requires (VTID-03851) — they merge/reject a real PR', () => {
    for (const body of [approveBody(), rejectBody()]) {
      const gateIdx = body.indexOf('isExecuteTaskAuthorized(getThreadAuth(threadId))');
      const callIdx = body.search(/await (approveApprovalById|rejectApprovalById)\(/);
      expect(gateIdx).toBeGreaterThan(-1);
      expect(callIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeLessThan(callIdx);
      expect(body).toMatch(/if \(!authz\.ok\) \{\s*return \{ ok: false, error: describeExecuteTaskRefusal\(authz\.reason\) \};/);
    }
  });
});
