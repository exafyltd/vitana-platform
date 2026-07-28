// VTID-01178/01190 — unit tests for the autopilot "validator hard gate"
// (autopilot-validator.ts). validateForMerge() runs four gates in order —
// spec schema, code review, governance, security scan — and the merge
// endpoint is required to refuse whenever passed=false.
//
// Scope:
//   1. Spec schema validation (step 0) — required-field/enum/format/length
//      checks, and the hard block-on-invalid-spec short-circuit.
//   2. Code review checks — migration naming, secret-looking paths, missing
//      spec snapshot.
//   3. Governance check — delegates to github-service.evaluateGovernance(),
//      including its dynamic import and its own thrown-error handling.
//   4. Security scan — filename-pattern findings and their severity mapping.
//   5. Full-pipeline composition: overall passed = ALL FOUR gates passed;
//      markValidated() is called only when passed=true; OASIS events emitted
//      at each stage; unhandled exceptions are caught and reported, never
//      thrown to the caller.
//   6. hasValidatorPass()/getValidationResult() — the merge-gate delegates
//      to autopilot-controller via a lazy `require()`.

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

const mockMarkValidated = jest.fn().mockResolvedValue(true);
const mockMarkFailed = jest.fn().mockResolvedValue(true);
const mockGetAutopilotRun = jest.fn();
const mockGetSpecSnapshot = jest.fn();
const mockHasValidatorPass = jest.fn();
const mockGetValidatorResult = jest.fn();
jest.mock('../../src/services/autopilot-controller', () => ({
  markValidated: (...args: any[]) => mockMarkValidated(...args),
  markFailed: (...args: any[]) => mockMarkFailed(...args),
  getAutopilotRun: (...args: any[]) => mockGetAutopilotRun(...args),
  getSpecSnapshot: (...args: any[]) => mockGetSpecSnapshot(...args),
  hasValidatorPass: (...args: any[]) => mockHasValidatorPass(...args),
  getValidatorResult: (...args: any[]) => mockGetValidatorResult(...args),
}));

const mockGetVtidSpec = jest.fn();
const mockEnforceSpecRequirement = jest.fn();
jest.mock('../../src/services/vtid-spec-service', () => ({
  getVtidSpec: (...args: any[]) => mockGetVtidSpec(...args),
  enforceSpecRequirement: (...args: any[]) => mockEnforceSpecRequirement(...args),
}));

const mockEvaluateGovernance = jest.fn();
jest.mock('../../src/services/github-service', () => ({
  __esModule: true,
  default: { evaluateGovernance: (...args: any[]) => mockEvaluateGovernance(...args) },
  evaluateGovernance: (...args: any[]) => mockEvaluateGovernance(...args),
}));

import { validateForMerge, hasValidatorPass, getValidationResult } from '../../src/services/autopilot-validator';

const VTID = 'VTID-01178';

function specContent(overrides: Record<string, any> = {}) {
  return {
    vtid: VTID,
    title: 'Autopilot validator coverage',
    spec_text: 'A sufficiently long spec description for validation purposes.',
    snapshot_created_at: '2026-07-01T00:00:00Z',
    layer: 'DEV',
    creativity: 'ALLOWED',
    execution_mode: 'Autonomous',
    ...overrides,
  };
}

function spec(overrides: Record<string, any> = {}, contentOverrides: Record<string, any> = {}) {
  return {
    vtid: VTID,
    tenant_id: 'default',
    spec_version: 1,
    spec_content: specContent(contentOverrides),
    spec_checksum: 'checksum-abc',
    primary_domain: 'backend',
    system_surface: [],
    created_at: '2026-07-01T00:00:00Z',
    locked_at: '2026-07-01T00:00:00Z',
    created_by: 'test',
    ...overrides,
  };
}

const APPROVED_GOVERNANCE = {
  decision: 'approved' as const,
  vtid: VTID,
  files_touched: [],
  services_impacted: [],
  blocked_reasons: [],
  timestamp: '2026-07-01T00:00:00Z',
};

const BASE_REQUEST = {
  vtid: VTID,
  pr_number: 42,
  repo: 'exafyltd/vitana-platform',
  files_changed: ['services/gateway/src/foo.ts'],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockEmitOasisEvent.mockResolvedValue({ ok: true });
  mockMarkValidated.mockResolvedValue(true);
  mockMarkFailed.mockResolvedValue(true);
  mockEnforceSpecRequirement.mockResolvedValue({ allowed: true, spec: spec() });
  mockGetSpecSnapshot.mockResolvedValue({ id: 'spec-1', vtid: VTID, title: 't', spec_content: 'x', created_at: '2026-07-01T00:00:00Z', checksum: 'c' });
  mockEvaluateGovernance.mockResolvedValue(APPROVED_GOVERNANCE);
});

function eventTypes() {
  return mockEmitOasisEvent.mock.calls.map((c) => c[0].type);
}

// ---------------------------------------------------------------------------
// 1. Spec schema validation (step 0) — hard block on failure
// ---------------------------------------------------------------------------

describe('validateForMerge — spec schema validation', () => {
  it('blocks immediately (no code review/governance/security) when enforceSpecRequirement denies', async () => {
    mockEnforceSpecRequirement.mockResolvedValue({
      allowed: false,
      error: 'No persisted spec found',
      error_code: 'SPEC_NOT_FOUND',
    });

    const res = await validateForMerge(BASE_REQUEST);

    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.result?.code_review_passed).toBe(false);
    expect(res.result?.governance_passed).toBe(false);
    expect(res.result?.security_scan_passed).toBe(false);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'SPEC_NOT_FOUND' })])
    );
    // Downstream gates never ran.
    expect(mockEvaluateGovernance).not.toHaveBeenCalled();
    expect(mockMarkValidated).not.toHaveBeenCalled();
    expect(eventTypes()).toEqual([
      'autopilot.validation.started',
      'autopilot.validation.spec_validation',
      'autopilot.validation.blocked',
    ]);
  });

  it('defaults the issue code to SPEC_INVALID when enforcement omits an error_code', async () => {
    mockEnforceSpecRequirement.mockResolvedValue({ allowed: false, error: 'bad spec' });
    const res = await validateForMerge(BASE_REQUEST);
    expect(res.result?.issues[0].code).toBe('SPEC_INVALID');
  });

  it('blocks on a missing required field (e.g. title) even though enforcement itself allowed the spec', async () => {
    mockEnforceSpecRequirement.mockResolvedValue({
      allowed: true,
      spec: spec({}, { title: '' }),
    });

    const res = await validateForMerge(BASE_REQUEST);

    expect(res.passed).toBe(false);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'error', code: 'SPEC_MISSING_FIELD', message: expect.stringContaining('title') }),
      ])
    );
    expect(mockEvaluateGovernance).not.toHaveBeenCalled();
  });

  it('treats invalid domain/layer/creativity/execution_mode/VTID-format/short-text as warnings only — does not block', async () => {
    mockEnforceSpecRequirement.mockResolvedValue({
      allowed: true,
      spec: spec(
        { vtid: 'not-a-vtid', primary_domain: 'not_a_real_domain' },
        {
          vtid: 'not-a-vtid',
          layer: 'NOT_A_LAYER',
          creativity: 'NOT_A_LEVEL',
          execution_mode: 'NOT_A_MODE',
          spec_text: 'short',
        }
      ),
    });

    const res = await validateForMerge(BASE_REQUEST);

    // None of these are errors, so the pipeline proceeds and (with the
    // other gates green via beforeEach defaults) ultimately passes.
    expect(res.passed).toBe(true);
    const codes = res.result!.issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'SPEC_INVALID_DOMAIN',
        'SPEC_INVALID_LAYER',
        'SPEC_INVALID_CREATIVITY',
        'SPEC_INVALID_EXECUTION_MODE',
        'SPEC_INVALID_VTID_FORMAT',
        'SPEC_TEXT_TOO_SHORT',
      ])
    );
    expect(res.result!.issues.every((i) => i.severity !== 'error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Code review checks
// ---------------------------------------------------------------------------

describe('validateForMerge — code review', () => {
  it('fails when no spec snapshot is found (VTID-01190: upgraded to error)', async () => {
    mockGetSpecSnapshot.mockResolvedValue(null);

    const res = await validateForMerge(BASE_REQUEST);

    expect(res.passed).toBe(false);
    expect(res.result?.code_review_passed).toBe(false);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'NO_SPEC_SNAPSHOT', severity: 'error' })])
    );
  });

  it('fails on a file path that looks like it may contain secrets', async () => {
    const res = await validateForMerge({ ...BASE_REQUEST, files_changed: ['services/gateway/.env.production'] });

    expect(res.passed).toBe(false);
    expect(res.result?.code_review_passed).toBe(false);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'POTENTIAL_SECRET', severity: 'error', file: 'services/gateway/.env.production' })])
    );
  });

  it('warns (does not fail) on a migration file — code review still passes', async () => {
    const res = await validateForMerge({
      ...BASE_REQUEST,
      files_changed: ['supabase/migrations/20260101000000_vtid_01178_add_table.sql'],
    });

    expect(res.result?.code_review_passed).toBe(true);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'MIGRATION_NAMING', severity: 'warning' })])
    );
    // Regression note: the naming-convention regex anchors to the START of
    // the full path (`^\d{14}_vtid_`), not the basename — so this warning
    // fires for every /migrations/ file regardless of whether the filename
    // itself follows the convention, as long as it's not the very first
    // path segment. Captured here as current behavior, not endorsed.
  });

  it('passes cleanly with an ordinary source file and no secrets', async () => {
    const res = await validateForMerge({ ...BASE_REQUEST, files_changed: ['services/gateway/src/routes/foo.ts'] });
    expect(res.result?.code_review_passed).toBe(true);
    expect(res.result?.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Governance check
// ---------------------------------------------------------------------------

describe('validateForMerge — governance', () => {
  it('passes when github-service governance evaluation approves', async () => {
    mockEvaluateGovernance.mockResolvedValue(APPROVED_GOVERNANCE);
    const res = await validateForMerge(BASE_REQUEST);
    expect(res.result?.governance_passed).toBe(true);
    expect(mockEvaluateGovernance).toHaveBeenCalledWith(BASE_REQUEST.repo, BASE_REQUEST.pr_number, VTID);
  });

  it('fails and records blocked_reasons when governance blocks', async () => {
    mockEvaluateGovernance.mockResolvedValue({
      decision: 'blocked' as const,
      vtid: VTID,
      files_touched: ['services/gateway/.env'],
      services_impacted: ['gateway'],
      blocked_reasons: ['Sensitive path: services/gateway/.env'],
      timestamp: '2026-07-01T00:00:00Z',
    });

    const res = await validateForMerge(BASE_REQUEST);

    expect(res.passed).toBe(false);
    expect(res.result?.governance_passed).toBe(false);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'GOVERNANCE_BLOCKED', message: expect.stringContaining('Sensitive path') }),
      ])
    );
  });

  it('treats a thrown governance evaluation as blocked, not as an unhandled crash', async () => {
    mockEvaluateGovernance.mockRejectedValue(new Error('GitHub API unreachable'));

    const res = await validateForMerge(BASE_REQUEST);

    expect(res.ok).toBe(true); // validateForMerge itself does not throw
    expect(res.passed).toBe(false);
    expect(res.result?.governance_passed).toBe(false);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'GOVERNANCE_BLOCKED', message: expect.stringContaining('GitHub API unreachable') })])
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Security scan
// ---------------------------------------------------------------------------

describe('validateForMerge — security scan', () => {
  it('passes cleanly with no suspicious filenames', async () => {
    const res = await validateForMerge({ ...BASE_REQUEST, files_changed: ['services/gateway/src/routes/foo.ts'] });
    expect(res.result?.security_scan_passed).toBe(true);
  });

  it('flags (but does not block on) a filename suggesting code execution', async () => {
    const res = await validateForMerge({ ...BASE_REQUEST, files_changed: ['services/gateway/src/evalRunner.ts'] });

    expect(res.result?.security_scan_passed).toBe(true); // medium severity does not fail the scan
    expect(res.passed).toBe(true);
    expect(res.result?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SUSPICIOUS_FILENAME', severity: 'warning' })])
    );
  });

  it('only scans .ts/.js files — a suspicious non-JS/TS filename is not flagged', async () => {
    const res = await validateForMerge({ ...BASE_REQUEST, files_changed: ['scripts/eval_report.py'] });
    expect(res.result?.issues.some((i) => i.code === 'SUSPICIOUS_FILENAME')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Full-pipeline composition
// ---------------------------------------------------------------------------

describe('validateForMerge — full pipeline composition', () => {
  it('passes overall only when spec + code review + governance + security ALL pass, and calls markValidated', async () => {
    const res = await validateForMerge(BASE_REQUEST);

    expect(res.passed).toBe(true);
    expect(res.result).toMatchObject({
      passed: true,
      code_review_passed: true,
      governance_passed: true,
      security_scan_passed: true,
    });
    expect(mockMarkValidated).toHaveBeenCalledWith(VTID, expect.objectContaining({ passed: true }));
    expect(eventTypes()).toEqual([
      'autopilot.validation.started',
      'autopilot.validation.spec_validation',
      'autopilot.validation.code_review',
      'autopilot.validation.governance',
      'autopilot.validation.security',
      'autopilot.validation.completed',
    ]);
  });

  it('does NOT call markValidated when any single gate fails (governance here), and emits a blocked event instead of completed', async () => {
    mockEvaluateGovernance.mockResolvedValue({
      decision: 'blocked' as const,
      vtid: VTID,
      files_touched: [],
      services_impacted: [],
      blocked_reasons: ['policy violation'],
      timestamp: '2026-07-01T00:00:00Z',
    });

    const res = await validateForMerge(BASE_REQUEST);

    expect(res.passed).toBe(false);
    expect(mockMarkValidated).not.toHaveBeenCalled();
    expect(eventTypes()[eventTypes().length - 1]).toBe('autopilot.validation.blocked');
  });

  it('catches unexpected exceptions and returns a VALIDATION_ERROR response rather than throwing', async () => {
    mockEnforceSpecRequirement.mockRejectedValue(new Error('DB connection lost'));

    const res = await validateForMerge(BASE_REQUEST);

    expect(res.ok).toBe(false);
    expect(res.passed).toBe(false);
    expect(res.error).toBe('DB connection lost');
    expect(res.error_code).toBe('VALIDATION_ERROR');
    expect(mockMarkValidated).not.toHaveBeenCalled();
    // A blocked/error OASIS event was still emitted for traceability.
    expect(eventTypes()).toContain('autopilot.validation.blocked');
  });

  it('defaults repo/files_changed when the caller omits them', async () => {
    await validateForMerge({ vtid: VTID, pr_number: 7 });
    expect(mockEvaluateGovernance).toHaveBeenCalledWith('exafyltd/vitana-platform', 7, VTID);
  });
});

// ---------------------------------------------------------------------------
// 6. hasValidatorPass() / getValidationResult() — merge-gate delegation
// ---------------------------------------------------------------------------

describe('hasValidatorPass / getValidationResult (delegate to autopilot-controller)', () => {
  it('hasValidatorPass forwards to controller.hasValidatorPass and returns its result', () => {
    mockHasValidatorPass.mockReturnValue(true);
    expect(hasValidatorPass(VTID)).toBe(true);
    expect(mockHasValidatorPass).toHaveBeenCalledWith(VTID);

    mockHasValidatorPass.mockReturnValue(false);
    expect(hasValidatorPass(VTID)).toBe(false);
  });

  it('getValidationResult forwards to controller.getValidatorResult and returns its result', () => {
    const result = { passed: true, code_review_passed: true, governance_passed: true, security_scan_passed: true, issues: [], validated_at: '2026-07-01T00:00:00Z' };
    mockGetValidatorResult.mockReturnValue(result);

    expect(getValidationResult(VTID)).toEqual(result);
    expect(mockGetValidatorResult).toHaveBeenCalledWith(VTID);
  });

  it('getValidationResult returns null when the controller has no result for the VTID', () => {
    mockGetValidatorResult.mockReturnValue(null);
    expect(getValidationResult('VTID-99999')).toBeNull();
  });
});
