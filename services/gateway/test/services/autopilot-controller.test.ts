// Autopilot Controller (VTID-01178) — unit tests
//
// This is the "brain" that drives every VTID through the autonomous
// pipeline (allocated -> in_progress -> ... -> completed/failed). It is
// the highest blast-radius file in the codebase because it is the sole
// writer of vtid_ledger's terminal fields and the sole enforcer of the
// "no spec, no execution" governance gate.
//
// Scope of this suite:
//   1. Pure helpers: extractErrorContext / deriveFailureTrigger
//   2. Spec snapshot lifecycle (createSpecSnapshot / getSpecSnapshot /
//      verifySpecIntegrity) — DB-backed via vtid-spec-service (mocked)
//   3. startAutopilotRun — the SPEC ENFORCEMENT hard gate
//   4. markInProgress — the CRITICAL execution-approval gate (VTID-01190)
//      + the state-machine-integrity bugfix made alongside this suite
//   5. Every other mark* state transition + the strict state machine
//      (VALID_TRANSITIONS) that backs all of them
//   6. markCompleted / markFailed idempotency
//   7. updateLedgerTerminal — the PR-J self-healing terminal-write gate
//      (VTID-02952): the single most safety-critical function in the
//      file, since it is the only thing standing between a self-healing
//      VTID and a false-positive 'success' write.
//   8. hasValidatorPass / getValidatorResult — the merge hard gate
//   9. getAutopilotStatus / getActiveRuns counting
//
// Mocking strategy: mock at the module boundary (./oasis-event-service,
// ./vtid-spec-service) and global.fetch (the raw Supabase REST calls this
// file makes directly). No real network/DB access.

// ---------------------------------------------------------------------------
// Module mocks (must precede the import of the module under test)
// ---------------------------------------------------------------------------

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(),
}));

jest.mock('../../src/services/vtid-spec-service', () => ({
  createVtidSpec: jest.fn(),
  getVtidSpec: jest.fn(),
  vtidSpecExists: jest.fn(),
  verifySpecChecksum: jest.fn(),
  enforceSpecRequirement: jest.fn(),
  toLegacySnapshot: jest.fn(),
}));

import { emitOasisEvent } from '../../src/services/oasis-event-service';
import {
  createVtidSpec,
  getVtidSpec,
  vtidSpecExists,
  verifySpecChecksum,
  enforceSpecRequirement,
  toLegacySnapshot,
} from '../../src/services/vtid-spec-service';
import * as controller from '../../src/services/autopilot-controller';

const mockEmit = emitOasisEvent as jest.Mock;
const mockCreateVtidSpec = createVtidSpec as jest.Mock;
const mockGetVtidSpec = getVtidSpec as jest.Mock;
const mockVtidSpecExists = vtidSpecExists as jest.Mock;
const mockVerifySpecChecksum = verifySpecChecksum as jest.Mock;
const mockEnforceSpecRequirement = enforceSpecRequirement as jest.Mock;
const mockToLegacySnapshot = toLegacySnapshot as jest.Mock;
const mockFetch = global.fetch as jest.Mock;

// ---------------------------------------------------------------------------
// Test fixtures / helpers
// ---------------------------------------------------------------------------

let vtidCounter = 0;
function uniqVtid(label: string): string {
  vtidCounter += 1;
  return `VTID-TEST-${label}-${vtidCounter}`;
}

function fakeVtidSpec(vtid: string, overrides: Record<string, unknown> = {}): any {
  const title = (overrides.title as string) || `Title for ${vtid}`;
  const specText = (overrides.spec_text as string) || 'spec body';
  return {
    vtid,
    tenant_id: 'tenant-1',
    spec_version: 1,
    spec_content: {
      vtid,
      title,
      spec_text: specText,
      task_domain: overrides.task_domain,
      target_paths: overrides.target_paths,
      snapshot_created_at: new Date().toISOString(),
    },
    spec_checksum: (overrides.spec_checksum as string) || `checksum-${vtid}`,
    primary_domain: (overrides.task_domain as string) || 'unknown',
    system_surface: [],
    created_at: new Date().toISOString(),
    locked_at: (overrides.locked_at as string) ?? new Date().toISOString(),
    created_by: 'autopilot-controller',
  };
}

function legacyFromSpec(spec: any) {
  return {
    id: `spec-${spec.vtid}`,
    vtid: spec.vtid,
    title: spec.spec_content.title,
    spec_content: spec.spec_content.spec_text,
    task_domain: spec.spec_content.task_domain,
    target_paths: spec.spec_content.target_paths,
    created_at: spec.created_at,
    checksum: spec.spec_checksum,
  };
}

/** In-memory fake backing store for the mocked vtid-spec-service module. */
let specStore: Map<string, any>;

function jsonResponse(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
}

function defaultFetchImpl(url: any, opts?: any) {
  const u = String(url);
  const method = (opts?.method || 'GET').toUpperCase();
  if (u.includes('/rest/v1/vtid_ledger')) {
    if (method === 'GET') {
      // Default: no self-healing metadata, no rows found (safe/neutral default)
      return Promise.resolve(jsonResponse(200, []));
    }
    if (method === 'PATCH') {
      return Promise.resolve(jsonResponse(200, [{}]));
    }
    if (method === 'POST') {
      return Promise.resolve(jsonResponse(201, [{}]));
    }
  }
  if (u.includes('/rest/v1/dev_autopilot_executions')) {
    return Promise.resolve(jsonResponse(200, []));
  }
  return Promise.resolve(jsonResponse(200, {}));
}

/** Start a run + advance it through in_progress for tests that need an
 * active, non-terminal run to operate on. */
async function startRun(vtid: string, opts: { title?: string; specText?: string } = {}) {
  specStore.set(vtid, fakeVtidSpec(vtid, { title: opts.title, spec_text: opts.specText }));
  return controller.startAutopilotRun(vtid, opts.title || `Title ${vtid}`, opts.specText || 'spec body');
}

beforeEach(() => {
  specStore = new Map();
  jest.clearAllMocks();

  mockEmit.mockResolvedValue({ ok: true, event_id: 'evt-1' });

  mockGetVtidSpec.mockImplementation(async (vtid: string) => specStore.get(vtid) || null);
  mockCreateVtidSpec.mockImplementation(async (req: any) => {
    if (specStore.has(req.vtid) && specStore.get(req.vtid).vtid === req.vtid) {
      return { ok: true, spec: specStore.get(req.vtid) };
    }
    const spec = fakeVtidSpec(req.vtid, {
      title: req.title,
      spec_text: req.spec_text,
      task_domain: req.task_domain,
      target_paths: req.target_paths,
    });
    specStore.set(req.vtid, spec);
    return { ok: true, spec };
  });
  mockVtidSpecExists.mockImplementation(async (vtid: string) => specStore.has(vtid));
  mockVerifySpecChecksum.mockImplementation(async (vtid: string) => {
    const spec = specStore.get(vtid);
    return {
      vtid,
      valid: !!spec,
      stored_checksum: spec?.spec_checksum ?? null,
      computed_checksum: spec?.spec_checksum ?? null,
      locked_at: spec?.locked_at ?? null,
    };
  });
  mockEnforceSpecRequirement.mockImplementation(async (vtid: string) => {
    const spec = specStore.get(vtid);
    if (!spec) {
      return { allowed: false, error: `No persisted spec found for ${vtid} - VTID cannot execute without spec`, error_code: 'SPEC_NOT_FOUND' };
    }
    if (!spec.locked_at) {
      return { allowed: false, error: `Spec is not locked for ${vtid}`, error_code: 'SPEC_NOT_LOCKED' };
    }
    return { allowed: true, spec };
  });
  mockToLegacySnapshot.mockImplementation((spec: any) => legacyFromSpec(spec));

  mockFetch.mockReset();
  mockFetch.mockImplementation((url: any, opts: any) => defaultFetchImpl(url, opts));
});

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe('extractErrorContext', () => {
  it('extracts name/message/stack prefix from a real Error', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\nat a\nat b\nat c\nat d\nat e';
    const ctx = controller.extractErrorContext(err);
    expect(ctx.error_name).toBe('Error');
    expect(ctx.error_message).toBe('boom');
    expect(ctx.stack_prefix?.split('\n')).toHaveLength(4);
  });

  it('extracts fields from a plain structured object', () => {
    const ctx = controller.extractErrorContext({ error_name: 'CustomErr', message: 'oops', stack: 'l1\nl2' });
    expect(ctx.error_name).toBe('CustomErr');
    expect(ctx.error_message).toBe('oops');
    expect(ctx.stack_prefix).toBe('l1\nl2');
  });

  it('wraps a plain string as error_message', () => {
    expect(controller.extractErrorContext('just a string')).toEqual({ error_message: 'just a string' });
  });

  it('falls back to fallbackMessage when given nothing usable', () => {
    expect(controller.extractErrorContext(null, 'fallback text')).toEqual({ error_message: 'fallback text' });
    expect(controller.extractErrorContext(undefined)).toEqual({});
  });
});

describe('deriveFailureTrigger', () => {
  it('prefers an explicit errorCode over everything else', () => {
    expect(controller.deriveFailureTrigger('MY_CODE', { error_name: 'X', error_message: 'Y' })).toBe('MY_CODE');
  });

  it('falls back to error_name when no errorCode is given', () => {
    expect(controller.deriveFailureTrigger(undefined, { error_name: 'TypeError', error_message: 'Y' })).toBe('TypeError');
  });

  it('falls back to a compacted error_message when no code/name available', () => {
    const ctx = { error_message: '  multi\nline    message with   spaces  ' };
    expect(controller.deriveFailureTrigger(undefined, ctx)).toBe('multi line message with spaces');
  });

  it('truncates a long error_message to 60 chars', () => {
    const long = 'x'.repeat(200);
    const trigger = controller.deriveFailureTrigger(undefined, { error_message: long });
    expect(trigger.length).toBe(60);
  });

  it('falls back to source_event_type when message/name are empty', () => {
    expect(controller.deriveFailureTrigger(undefined, { source_event_type: 'worker.execution.failed' })).toBe('worker.execution.failed');
  });

  it('never returns the legacy "unknown_error" default — falls back to "unspecified_failure"', () => {
    expect(controller.deriveFailureTrigger(undefined, undefined)).toBe('unspecified_failure');
    expect(controller.deriveFailureTrigger('', {})).toBe('unspecified_failure');
  });

  it('treats a whitespace-only errorCode as absent', () => {
    expect(controller.deriveFailureTrigger('   ', { error_name: 'RealName' })).toBe('RealName');
  });
});

// ---------------------------------------------------------------------------
// 2. Spec snapshot lifecycle
// ---------------------------------------------------------------------------

describe('createSpecSnapshot', () => {
  it('creates a new spec via createVtidSpec when none exists yet', async () => {
    const vtid = uniqVtid('spec-new');
    const snap = await controller.createSpecSnapshot(vtid, 'My Title', 'spec text body');

    expect(mockCreateVtidSpec).toHaveBeenCalledWith(expect.objectContaining({
      vtid,
      title: 'My Title',
      spec_text: 'spec text body',
      created_by: 'autopilot-controller',
    }));
    expect(snap.vtid).toBe(vtid);
    expect(snap.title).toBe('My Title');
    expect(snap.spec_content).toBe('spec text body');
  });

  it('returns the existing spec without calling createVtidSpec again (idempotent / immutable)', async () => {
    const vtid = uniqVtid('spec-existing');
    specStore.set(vtid, fakeVtidSpec(vtid, { title: 'Original Title' }));

    const snap = await controller.createSpecSnapshot(vtid, 'A different title', 'different text');

    expect(mockCreateVtidSpec).not.toHaveBeenCalled();
    expect(snap.title).toBe('Original Title'); // original spec wins — immutability preserved
  });

  it('falls back to a local (non-persisted) snapshot when createVtidSpec fails, without throwing', async () => {
    const vtid = uniqVtid('spec-fail');
    mockCreateVtidSpec.mockResolvedValueOnce({ ok: false, error: 'db down' });

    const snap = await controller.createSpecSnapshot(vtid, 'Fallback Title', 'fallback text');

    expect(snap.vtid).toBe(vtid);
    expect(snap.title).toBe('Fallback Title');
    expect(snap.spec_content).toBe('fallback text');
    expect(typeof snap.checksum).toBe('string');
    expect(snap.checksum.length).toBeGreaterThan(0);
  });
});

describe('getSpecSnapshot / verifySpecIntegrity', () => {
  it('returns null when no spec is persisted', async () => {
    expect(await controller.getSpecSnapshot(uniqVtid('missing'))).toBeNull();
  });

  it('returns the legacy snapshot shape when a spec exists', async () => {
    const vtid = uniqVtid('spec-get');
    specStore.set(vtid, fakeVtidSpec(vtid, { title: 'Fetched Title' }));
    const snap = await controller.getSpecSnapshot(vtid);
    expect(snap?.title).toBe('Fetched Title');
  });

  it('verifySpecIntegrity reflects the checksum verification result', async () => {
    const vtid = uniqVtid('spec-verify');
    specStore.set(vtid, fakeVtidSpec(vtid));
    expect(await controller.verifySpecIntegrity(vtid)).toBe(true);
    expect(await controller.verifySpecIntegrity(uniqVtid('spec-verify-missing'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. startAutopilotRun — the SPEC ENFORCEMENT hard gate
// ---------------------------------------------------------------------------

describe('startAutopilotRun — spec enforcement governance gate', () => {
  it('starts a new run in the "allocated" state once the spec is verified persisted', async () => {
    const vtid = uniqVtid('start-happy');
    const run = await controller.startAutopilotRun(vtid, 'Title', 'spec text');

    expect(run.state).toBe('allocated');
    expect(run.vtid).toBe(vtid);
    expect(mockEnforceSpecRequirement).toHaveBeenCalledWith(vtid);
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      vtid,
      type: 'autopilot.run.started',
      payload: expect.objectContaining({ spec_verified: true }),
    }));
  });

  it('HARD GATE: throws and never registers a run when spec persistence enforcement fails', async () => {
    const vtid = uniqVtid('start-blocked');
    // Force createSpecSnapshot to "succeed" locally (fallback path) but
    // enforceSpecRequirement to still reject — simulating the DB write
    // silently not landing.
    mockCreateVtidSpec.mockResolvedValueOnce({ ok: false, error: 'simulated db failure' });
    mockEnforceSpecRequirement.mockResolvedValueOnce({
      allowed: false,
      error: 'No persisted spec found',
      error_code: 'SPEC_NOT_FOUND',
    });

    await expect(controller.startAutopilotRun(vtid, 'Title', 'spec text'))
      .rejects.toThrow(/SPEC REQUIRED/);

    // No VTID may execute without a persisted spec — the run must not exist.
    expect(controller.getAutopilotRun(vtid)).toBeNull();
  });

  it('is idempotent: a second call for the same active (non-terminal) run returns the existing run, not a new one', async () => {
    const vtid = uniqVtid('start-idempotent');
    const first = await controller.startAutopilotRun(vtid, 'Title', 'spec text');
    const second = await controller.startAutopilotRun(vtid, 'Title', 'spec text');

    expect(second.id).toBe(first.id);
    // Spec creation must only happen once — the second call is idempotent.
    expect(mockCreateVtidSpec).toHaveBeenCalledTimes(1);
  });

  it('re-verifies the spec on the idempotent path and fails the ALREADY-ACTIVE run if the spec became invalid', async () => {
    const vtid = uniqVtid('start-idempotent-revoked');
    await controller.startAutopilotRun(vtid, 'Title', 'spec text');

    // Simulate the persisted spec disappearing/becoming invalid between calls.
    specStore.delete(vtid);

    await expect(controller.startAutopilotRun(vtid, 'Title', 'spec text'))
      .rejects.toThrow(/SPEC REQUIRED/);

    // The existing run must be marked failed, not silently ignored.
    expect(controller.getAutopilotRun(vtid)?.state).toBe('failed');
  });

  it('starts a brand-new run (fresh spec snapshot) when the previous run for the same VTID already reached a terminal state', async () => {
    const vtid = uniqVtid('start-after-terminal');
    const first = await controller.startAutopilotRun(vtid, 'Title', 'spec text');
    await controller.markFailed(vtid, 'first attempt failed');
    expect(controller.getAutopilotRun(vtid)?.state).toBe('failed');

    const second = await controller.startAutopilotRun(vtid, 'Title retry', 'spec text v2');
    expect(second.id).not.toBe(first.id);
    expect(second.state).toBe('allocated');
  });
});

// ---------------------------------------------------------------------------
// 4. markInProgress — CRITICAL execution-approval gate
// ---------------------------------------------------------------------------

describe('markInProgress — critical execution gate (VTID-01190)', () => {
  it('returns false when no run exists for the VTID, without ever checking the spec', async () => {
    const vtid = uniqVtid('mip-no-run');
    const ok = await controller.markInProgress(vtid);
    expect(ok).toBe(false);
    expect(mockEnforceSpecRequirement).not.toHaveBeenCalledWith(vtid);
  });

  it('BLOCKS execution and emits governance.spec.execution_blocked when the spec is missing/invalid', async () => {
    const vtid = uniqVtid('mip-blocked');
    await startRun(vtid);
    specStore.delete(vtid); // spec vanished — must not be allowed to execute

    const ok = await controller.markInProgress(vtid);

    expect(ok).toBe(false);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('allocated'); // never transitioned
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      vtid,
      type: 'governance.spec.execution_blocked',
      status: 'error',
    }));

    // No ledger status write must have happened for the blocked attempt.
    const ledgerPatchCalls = mockFetch.mock.calls.filter(([url, opts]: any[]) =>
      String(url).includes('/rest/v1/vtid_ledger') && opts?.method === 'PATCH');
    expect(ledgerPatchCalls).toHaveLength(0);
  });

  it('transitions allocated -> in_progress and writes the ledger status when the spec is valid', async () => {
    const vtid = uniqVtid('mip-happy');
    await startRun(vtid);

    const ok = await controller.markInProgress(vtid, 'run-123');

    expect(ok).toBe(true);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('in_progress');

    const ledgerPatchCall = mockFetch.mock.calls.find(([url, opts]: any[]) =>
      String(url).includes(`/rest/v1/vtid_ledger?vtid=eq.${vtid}`) && opts?.method === 'PATCH');
    expect(ledgerPatchCall).toBeDefined();
    const body = JSON.parse(ledgerPatchCall![1].body);
    expect(body.status).toBe('in_progress');

    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      vtid,
      type: 'autopilot.state.in_progress',
    }));
  });

  it('BUGFIX regression: does NOT regress a terminal (completed) run back to in_progress, and does NOT write the ledger', async () => {
    const vtid = uniqVtid('mip-terminal-guard');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markBuilding(vtid);
    await controller.markPrCreated(vtid, 1, 'https://example.com/pr/1');
    await controller.markReviewing(vtid);
    await controller.markValidated(vtid, {
      passed: true, code_review_passed: true, governance_passed: true, security_scan_passed: true,
      issues: [], validated_at: new Date().toISOString(),
    });
    await controller.markMerged(vtid, 'sha123');
    await controller.markDeploying(vtid);
    await controller.markVerifying(vtid);
    await controller.markCompleted(vtid);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('completed');

    mockFetch.mockClear();
    const ok = await controller.markInProgress(vtid);

    expect(ok).toBe(false);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('completed'); // must NOT regress
    const ledgerPatchCalls = mockFetch.mock.calls.filter(([url, opts]: any[]) =>
      String(url).includes('/rest/v1/vtid_ledger') && opts?.method === 'PATCH');
    expect(ledgerPatchCalls).toHaveLength(0); // ledger must not be touched for a rejected transition
  });

  it('rejects markInProgress called on a run already past in_progress (e.g. "building"), leaving state untouched', async () => {
    const vtid = uniqVtid('mip-already-building');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markBuilding(vtid);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('building');

    const ok = await controller.markInProgress(vtid);
    expect(ok).toBe(false);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('building');
  });
});

// ---------------------------------------------------------------------------
// 5. Other state transitions + the strict state machine
// ---------------------------------------------------------------------------

describe('state transition handlers — happy paths', () => {
  it('markBuilding transitions in_progress -> building', async () => {
    const vtid = uniqVtid('t-building');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    expect(await controller.markBuilding(vtid)).toBe(true);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('building');
  });

  it('markPrCreated records pr_number/pr_url and transitions to pr_created', async () => {
    const vtid = uniqVtid('t-pr');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markBuilding(vtid);
    expect(await controller.markPrCreated(vtid, 42, 'https://github.com/x/y/pull/42')).toBe(true);
    const run = controller.getAutopilotRun(vtid);
    expect(run?.state).toBe('pr_created');
    expect(run?.pr_number).toBe(42);
    expect(run?.pr_url).toBe('https://github.com/x/y/pull/42');
  });

  it('markReviewing transitions pr_created -> reviewing', async () => {
    const vtid = uniqVtid('t-reviewing');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markBuilding(vtid);
    await controller.markPrCreated(vtid, 1, 'url');
    expect(await controller.markReviewing(vtid)).toBe(true);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('reviewing');
  });

  it('markValidated records the validator result and emits validator.passed on success', async () => {
    const vtid = uniqVtid('t-validated');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markBuilding(vtid);
    await controller.markPrCreated(vtid, 1, 'url');
    await controller.markReviewing(vtid);

    const result = {
      passed: true, code_review_passed: true, governance_passed: true, security_scan_passed: true,
      issues: [], validated_at: new Date().toISOString(),
    };
    expect(await controller.markValidated(vtid, result)).toBe(true);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('validated');
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ vtid, type: 'autopilot.validator.passed' }));
  });

  it('markValidated emits validator.failed when the result did not pass', async () => {
    const vtid = uniqVtid('t-validated-fail');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markBuilding(vtid);
    await controller.markPrCreated(vtid, 1, 'url');
    await controller.markReviewing(vtid);

    const result = {
      passed: false, code_review_passed: false, governance_passed: true, security_scan_passed: true,
      issues: [{ severity: 'error' as const, code: 'E1', message: 'bad' }], validated_at: new Date().toISOString(),
    };
    await controller.markValidated(vtid, result);
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ vtid, type: 'autopilot.validator.failed', status: 'warning' }));
  });

  it('markMerged records merge_sha and transitions validated -> merged', async () => {
    const vtid = uniqVtid('t-merged');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markBuilding(vtid);
    await controller.markPrCreated(vtid, 1, 'url');
    await controller.markReviewing(vtid);
    await controller.markValidated(vtid, {
      passed: true, code_review_passed: true, governance_passed: true, security_scan_passed: true, issues: [], validated_at: new Date().toISOString(),
    });
    expect(await controller.markMerged(vtid, 'abc123sha')).toBe(true);
    const run = controller.getAutopilotRun(vtid);
    expect(run?.state).toBe('merged');
    expect(run?.merge_sha).toBe('abc123sha');
  });

  it('markDeploying and markVerifying advance merged -> deploying -> verifying', async () => {
    const vtid = uniqVtid('t-deploy-verify');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markBuilding(vtid);
    await controller.markPrCreated(vtid, 1, 'url');
    await controller.markReviewing(vtid);
    await controller.markValidated(vtid, {
      passed: true, code_review_passed: true, governance_passed: true, security_scan_passed: true, issues: [], validated_at: new Date().toISOString(),
    });
    await controller.markMerged(vtid, 'sha');

    expect(await controller.markDeploying(vtid, 'https://ci/run/1')).toBe(true);
    expect(controller.getAutopilotRun(vtid)?.deploy_workflow_url).toBe('https://ci/run/1');
    expect(controller.getAutopilotRun(vtid)?.state).toBe('deploying');

    expect(await controller.markVerifying(vtid)).toBe(true);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('verifying');
  });

  it('all "mark*" handlers except markInProgress/markFailed return false (no-op) when no run exists', async () => {
    const vtid = uniqVtid('t-no-run');
    expect(await controller.markBuilding(vtid)).toBe(false);
    expect(await controller.markPrCreated(vtid, 1, 'url')).toBe(false);
    expect(await controller.markReviewing(vtid)).toBe(false);
    expect(await controller.markValidated(vtid, {
      passed: true, code_review_passed: true, governance_passed: true, security_scan_passed: true, issues: [], validated_at: 'now',
    })).toBe(false);
    expect(await controller.markMerged(vtid, 'sha')).toBe(false);
    expect(await controller.markDeploying(vtid)).toBe(false);
    expect(await controller.markVerifying(vtid)).toBe(false);
    expect(await controller.markCompleted(vtid)).toBe(false);
  });
});

describe('state machine integrity — invalid transitions are rejected', () => {
  it('rejects skipping states (e.g. allocated straight to building)', async () => {
    const vtid = uniqVtid('skip-state');
    await startRun(vtid);
    // Never called markInProgress — still "allocated".
    const ok = await controller.markBuilding(vtid);
    expect(ok).toBe(false);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('allocated');
  });

  it('a "completed" run accepts no further transitions at all', async () => {
    const vtid = uniqVtid('terminal-completed');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markCompleted(vtid); // building/etc skipped is allowed: any state -> completed directly
    expect(controller.getAutopilotRun(vtid)?.state).toBe('completed');

    expect(await controller.markBuilding(vtid)).toBe(false);
    expect(await controller.markVerifying(vtid)).toBe(false);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('completed');
  });

  it('allows the documented recovery transition failed -> completed (VTID-01208)', async () => {
    const vtid = uniqVtid('recovery');
    await startRun(vtid);
    await controller.markFailed(vtid, 'transient error');
    expect(controller.getAutopilotRun(vtid)?.state).toBe('failed');

    expect(await controller.markCompleted(vtid)).toBe(true);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 6. markCompleted / markFailed — idempotency
// ---------------------------------------------------------------------------

describe('markCompleted', () => {
  it('writes the ledger to terminal success and emits the completed transition', async () => {
    const vtid = uniqVtid('complete-happy');
    await startRun(vtid);
    await controller.markInProgress(vtid);

    await controller.markCompleted(vtid, {
      passed: true, health_check_passed: true, acceptance_assertions_passed: true, csp_check_passed: true,
      issues: [], verified_at: new Date().toISOString(),
    });

    // markInProgress() above also issues a PATCH (status: in_progress) —
    // find the terminal one specifically (identified by terminal_outcome).
    const patchCalls = mockFetch.mock.calls.filter(([url, opts]: any[]) =>
      String(url).includes(`/rest/v1/vtid_ledger?vtid=eq.${vtid}`) && opts?.method === 'PATCH');
    const terminalPatch = patchCalls.map(([, opts]: any[]) => JSON.parse(opts.body)).find((b: any) => b.terminal_outcome);
    expect(terminalPatch).toBeDefined();
    expect(terminalPatch.status).toBe('completed');
    expect(terminalPatch.is_terminal).toBe(true);
    expect(terminalPatch.terminal_outcome).toBe('success');

    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({ vtid, type: 'autopilot.verification.passed' }));
  });

  it('idempotency: calling markCompleted twice never corrupts run state — it stays "completed"', async () => {
    const vtid = uniqVtid('complete-idempotent');
    await startRun(vtid);
    await controller.markInProgress(vtid);

    const first = await controller.markCompleted(vtid);
    expect(first).toBe(true);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('completed');

    const second = await controller.markCompleted(vtid);
    // Second call must not throw and must not corrupt/move state elsewhere.
    expect(controller.getAutopilotRun(vtid)?.state).toBe('completed');
    expect(second).toBe(false); // no-op transition (already terminal) — caller should treat as already-done, not a crash
  });
});

describe('markFailed', () => {
  it('creates a minimal failed run record when no active run exists (does not throw)', async () => {
    const vtid = uniqVtid('fail-no-run');
    const ok = await controller.markFailed(vtid, 'boom', 'MY_ERROR_CODE');

    expect(ok).toBe(true);
    expect(controller.getAutopilotRun(vtid)?.state).toBe('failed');
    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      vtid,
      type: 'autopilot.state.failed',
      payload: expect.objectContaining({ trigger: 'MY_ERROR_CODE', no_active_run: true }),
    }));

    const patchCall = mockFetch.mock.calls.find(([url, opts]: any[]) =>
      String(url).includes(`/rest/v1/vtid_ledger?vtid=eq.${vtid}`) && opts?.method === 'PATCH');
    const body = JSON.parse(patchCall![1].body);
    expect(body.status).toBe('rejected');
    expect(body.terminal_outcome).toBe('failed');
  });

  it('marks an active run as failed, recording error/error_code on the run', async () => {
    const vtid = uniqVtid('fail-active-run');
    await startRun(vtid);
    await controller.markInProgress(vtid);

    const ok = await controller.markFailed(vtid, 'CI failed', 'CI_FAILURE');
    expect(ok).toBe(true);
    const run = controller.getAutopilotRun(vtid);
    expect(run?.state).toBe('failed');
    expect(run?.error).toBe('CI failed');
    expect(run?.error_code).toBe('CI_FAILURE');
  });

  it('idempotency: calling markFailed twice on an already-failed run does not corrupt state', async () => {
    const vtid = uniqVtid('fail-idempotent');
    await controller.markFailed(vtid, 'first failure');
    expect(controller.getAutopilotRun(vtid)?.state).toBe('failed');

    const second = await controller.markFailed(vtid, 'second failure (duplicate event)');
    expect(controller.getAutopilotRun(vtid)?.state).toBe('failed'); // still failed, not corrupted
    expect(second).toBe(false); // failed -> failed is not a declared transition
  });

  it('never emits the legacy hardcoded "unknown_error" trigger — always derives a real reason', async () => {
    const vtid = uniqVtid('fail-trigger');
    await controller.markFailed(vtid, 'some real reason');
    const call = mockEmit.mock.calls.find((c) => c[0].type === 'autopilot.state.failed');
    expect(call![0].payload.trigger).not.toBe('unknown_error');
    expect(call![0].payload.trigger).toBe('some real reason');
  });
});

// ---------------------------------------------------------------------------
// 7. updateLedgerTerminal — PR-J self-healing terminal-write gate (VTID-02952)
// ---------------------------------------------------------------------------

describe('updateLedgerTerminal — PR-J self-healing gate (VTID-02952)', () => {
  it('writes terminal_outcome=failed unconditionally (the self-healing gate only applies to success)', async () => {
    const vtid = uniqVtid('ledger-fail-path');
    await controller.updateLedgerTerminal(vtid, 'failed');

    const patchCall = mockFetch.mock.calls.find(([url, opts]: any[]) =>
      String(url).includes(`/rest/v1/vtid_ledger?vtid=eq.${vtid}`) && opts?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall![1].body);
    expect(body.terminal_outcome).toBe('failed');
    expect(body.status).toBe('rejected');
  });

  it('writes terminal_outcome=success normally for a non-self-healing VTID', async () => {
    const vtid = uniqVtid('ledger-normal-success');
    mockFetch.mockImplementation((url: any, opts: any) => {
      const u = String(url);
      if (u.includes('/rest/v1/vtid_ledger') && (opts?.method || 'GET') === 'GET' && u.includes('select=metadata')) {
        return Promise.resolve(jsonResponse(200, [{ metadata: { source: 'manual' } }]));
      }
      return defaultFetchImpl(url, opts);
    });

    await controller.updateLedgerTerminal(vtid, 'success');

    const patchCall = mockFetch.mock.calls.find(([url, opts]: any[]) =>
      String(url).includes(`/rest/v1/vtid_ledger?vtid=eq.${vtid}`) && opts?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall![1].body);
    expect(body.terminal_outcome).toBe('success');
  });

  it('BLOCKS the success write for a self-healing VTID whose autopilot execution has not reached "completed"', async () => {
    const vtid = uniqVtid('ledger-self-healing-blocked');
    mockFetch.mockImplementation((url: any, opts: any) => {
      const u = String(url);
      const method = (opts?.method || 'GET').toUpperCase();
      if (u.includes('/rest/v1/vtid_ledger') && method === 'GET' && u.includes('select=metadata')) {
        return Promise.resolve(jsonResponse(200, [{ metadata: { source: 'self-healing', autopilot_execution_id: 'exec-1' } }]));
      }
      if (u.includes('/rest/v1/dev_autopilot_executions')) {
        return Promise.resolve(jsonResponse(200, [{ status: 'running' }])); // NOT completed
      }
      return defaultFetchImpl(url, opts);
    });

    await controller.updateLedgerTerminal(vtid, 'success');

    // The terminal PATCH must NEVER be sent — the reconciler is the only
    // authorized writer for self-healing VTIDs.
    const patchCall = mockFetch.mock.calls.find(([url, opts]: any[]) =>
      String(url).includes(`/rest/v1/vtid_ledger?vtid=eq.${vtid}`) && opts?.method === 'PATCH');
    expect(patchCall).toBeUndefined();

    expect(mockEmit).toHaveBeenCalledWith(expect.objectContaining({
      vtid,
      type: 'self-healing.terminalize.blocked',
      status: 'warning',
    }));
  });

  it('BLOCKS the success write when the self-healing metadata has no autopilot_execution_id at all', async () => {
    const vtid = uniqVtid('ledger-self-healing-missing-exec-id');
    mockFetch.mockImplementation((url: any, opts: any) => {
      const u = String(url);
      const method = (opts?.method || 'GET').toUpperCase();
      if (u.includes('/rest/v1/vtid_ledger') && method === 'GET' && u.includes('select=metadata')) {
        return Promise.resolve(jsonResponse(200, [{ metadata: { source: 'self-healing' } }]));
      }
      return defaultFetchImpl(url, opts);
    });

    await controller.updateLedgerTerminal(vtid, 'success');

    const patchCall = mockFetch.mock.calls.find(([url, opts]: any[]) =>
      String(url).includes(`/rest/v1/vtid_ledger?vtid=eq.${vtid}`) && opts?.method === 'PATCH');
    expect(patchCall).toBeUndefined();
  });

  it('ALLOWS the success write for a self-healing VTID once its execution status is "completed"', async () => {
    const vtid = uniqVtid('ledger-self-healing-allowed');
    mockFetch.mockImplementation((url: any, opts: any) => {
      const u = String(url);
      const method = (opts?.method || 'GET').toUpperCase();
      if (u.includes('/rest/v1/vtid_ledger') && method === 'GET' && u.includes('select=metadata')) {
        return Promise.resolve(jsonResponse(200, [{ metadata: { source: 'self-healing', autopilot_execution_id: 'exec-2' } }]));
      }
      if (u.includes('/rest/v1/dev_autopilot_executions')) {
        return Promise.resolve(jsonResponse(200, [{ status: 'completed' }]));
      }
      return defaultFetchImpl(url, opts);
    });

    await controller.updateLedgerTerminal(vtid, 'success');

    const patchCall = mockFetch.mock.calls.find(([url, opts]: any[]) =>
      String(url).includes(`/rest/v1/vtid_ledger?vtid=eq.${vtid}`) && opts?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall![1].body);
    expect(body.terminal_outcome).toBe('success');
  });

  it('fails OPEN (allows the write through) when the gate-check fetch itself throws — logged, not silently different behavior', async () => {
    const vtid = uniqVtid('ledger-gate-check-throws');
    mockFetch.mockImplementation((url: any, opts: any) => {
      const u = String(url);
      const method = (opts?.method || 'GET').toUpperCase();
      if (u.includes('/rest/v1/vtid_ledger') && method === 'GET' && u.includes('select=metadata')) {
        return Promise.reject(new Error('network blip'));
      }
      return defaultFetchImpl(url, opts);
    });

    await controller.updateLedgerTerminal(vtid, 'success');

    const patchCall = mockFetch.mock.calls.find(([url, opts]: any[]) =>
      String(url).includes(`/rest/v1/vtid_ledger?vtid=eq.${vtid}`) && opts?.method === 'PATCH');
    expect(patchCall).toBeDefined(); // gate-check failure does not block a legit write
  });

  it('is a no-op (does not throw) when Supabase credentials are missing', async () => {
    const originalUrl = process.env.SUPABASE_URL;
    const originalKey = process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    try {
      await expect(controller.updateLedgerTerminal(uniqVtid('no-creds'), 'success')).resolves.toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      process.env.SUPABASE_URL = originalUrl;
      process.env.SUPABASE_SERVICE_ROLE = originalKey;
    }
  });
});

// ---------------------------------------------------------------------------
// 8. hasValidatorPass / getValidatorResult — merge hard gate
// ---------------------------------------------------------------------------

describe('hasValidatorPass / getValidatorResult', () => {
  it('returns false and null for a VTID with no run at all', () => {
    const vtid = uniqVtid('validator-no-run');
    expect(controller.hasValidatorPass(vtid)).toBe(false);
    expect(controller.getValidatorResult(vtid)).toBeNull();
  });

  it('returns false when a run exists but has not been validated yet', async () => {
    const vtid = uniqVtid('validator-not-run-yet');
    await startRun(vtid);
    expect(controller.hasValidatorPass(vtid)).toBe(false);
  });

  it('returns true only after markValidated records passed:true', async () => {
    const vtid = uniqVtid('validator-pass');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markBuilding(vtid);
    await controller.markPrCreated(vtid, 1, 'url');
    await controller.markReviewing(vtid);
    await controller.markValidated(vtid, {
      passed: true, code_review_passed: true, governance_passed: true, security_scan_passed: true, issues: [], validated_at: 'now',
    });
    expect(controller.hasValidatorPass(vtid)).toBe(true);
    expect(controller.getValidatorResult(vtid)?.passed).toBe(true);
  });

  it('returns false when the validator explicitly failed — this is the merge hard gate', async () => {
    const vtid = uniqVtid('validator-fail');
    await startRun(vtid);
    await controller.markInProgress(vtid);
    await controller.markBuilding(vtid);
    await controller.markPrCreated(vtid, 1, 'url');
    await controller.markReviewing(vtid);
    await controller.markValidated(vtid, {
      passed: false, code_review_passed: false, governance_passed: true, security_scan_passed: true,
      issues: [{ severity: 'error' as const, code: 'E1', message: 'nope' }], validated_at: 'now',
    });
    expect(controller.hasValidatorPass(vtid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. getAutopilotStatus / getActiveRuns
// ---------------------------------------------------------------------------

describe('getAutopilotStatus / getActiveRuns', () => {
  it('counts allocated (active), completed, and failed runs correctly (delta-based to tolerate shared module state)', async () => {
    const before = controller.getAutopilotStatus();

    const vtidActive = uniqVtid('status-active');
    const vtidCompleted = uniqVtid('status-completed');
    const vtidFailed = uniqVtid('status-failed');

    await startRun(vtidActive); // stays allocated

    await startRun(vtidCompleted);
    await controller.markInProgress(vtidCompleted);
    await controller.markCompleted(vtidCompleted);

    await controller.markFailed(vtidFailed, 'boom');

    const after = controller.getAutopilotStatus();

    expect(after.active_runs - before.active_runs).toBe(1);
    expect(after.completed_runs - before.completed_runs).toBe(1);
    expect(after.failed_runs - before.failed_runs).toBe(1);
    expect(after.runs_by_state.allocated - before.runs_by_state.allocated).toBe(1);
    expect(after.runs_by_state.completed - before.runs_by_state.completed).toBe(1);
    expect(after.runs_by_state.failed - before.runs_by_state.failed).toBe(1);
  });

  it('getActiveRuns excludes completed and failed runs', async () => {
    const vtidActive = uniqVtid('active-runs-included');
    const vtidDone = uniqVtid('active-runs-excluded');

    await startRun(vtidActive);
    await startRun(vtidDone);
    await controller.markInProgress(vtidDone);
    await controller.markCompleted(vtidDone);

    const active = controller.getActiveRuns();
    const vtids = active.map((r) => r.vtid);
    expect(vtids).toContain(vtidActive);
    expect(vtids).not.toContain(vtidDone);
  });
});
