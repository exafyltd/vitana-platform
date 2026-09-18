// VTID-04052 — unit tests for the Command Hub path-ownership guard's marker check.
//
// Why this file exists at all: the guard's whole authorization decision used to
// be two inline regex tests inside main(), which shells out to `git diff` and
// calls process.exit(). Nothing about it was reachable from a test, so the one
// rule that decides whether a Command Hub PR is allowed to merge had no pins on
// it. VTID-04052 adds a second, narrower carve-out (the Dev Autopilot agent
// executor's own branch pattern) and, with it, extract the decision into
// evaluateMarkerAuthorization() so both the old and the new rule are testable.
//
// These pin BEHAVIOUR — what the guard approves and what it still rejects —
// following the same approach as validator-path-guard.test.ts: the module is
// required directly instead of its entry point being invoked.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../../../scripts/ci/command-hub-ownership-guard.js');

type Decision = { allowed: boolean; reason: string };

const decide = (branchName: string, prTitle: string): Decision =>
  guard.evaluateMarkerAuthorization(branchName, prTitle) as Decision;

describe('the pre-existing ALLOWED_VTID_PATTERN check is intact', () => {
  it('still approves an allowlisted VTID in the PR title', () => {
    // VTID-04033 is in the allowlist (see vtid-04033-operator-execution-follow).
    const r = decide('claude/clever-carson-64d3k5', 'VTID-04033: follow the execution you queued');
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('allowlisted-marker');
  });

  it('still approves an allowlisted VTID in the branch name', () => {
    expect(decide('claude/DEV-COMHU-0203-ticker-fix', '').allowed).toBe(true);
    expect(decide('claude/fix-ghost-cards', '').allowed).toBe(true);
  });

  it('is still present and unmodified in the source', () => {
    // The VTID-04052 change adds a carve-out; it must not delete or rewrite the
    // allowlist that DEV-COMHU work has depended on since VTID-0302.
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../../../scripts/ci/command-hub-ownership-guard.js'),
      'utf8',
    );
    expect(src).toMatch(/const ALLOWED_VTID_PATTERN = \/[^\n]*DEV-COMHU-\\d\+/);
    // And the VTID-04052 carve-out is reached only AFTER it (ordering matters:
    // a carve-out evaluated first could mask an allowlist regression).
    const allowlist = src.indexOf('const ALLOWED_VTID_PATTERN =');
    const carveOut = src.indexOf('DEV_AUTOPILOT_EXECUTOR_BRANCH_PATTERN.test(branchName)');
    expect(allowlist).toBeGreaterThan(-1);
    expect(carveOut).toBeGreaterThan(allowlist);
  });
});

describe('VTID-04052 — the Dev Autopilot agent-executor branch pattern', () => {
  it('(a) approves a dev-autopilot/* branch carrying a real VTID in the PR title', () => {
    const r = decide(
      'dev-autopilot/VTID-04052-command-hub-ownership-guard',
      'VTID-04052: add the Dev Autopilot executor branch carve-out',
    );
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('dev-autopilot-executor-branch-with-real-vtid');
  });

  it('accepts the executor branch with a 4-digit VTID too (VTID-\\d{4,5})', () => {
    expect(decide('dev-autopilot/VTID-04052-x', 'VTID-1234: something').allowed).toBe(true);
  });

  it('(b) still FAILS a dev-autopilot/* branch with no VTID in the PR title', () => {
    // No title at all — exactly the case that must not be waved through.
    const none = decide('dev-autopilot/VTID-04052-command-hub-ownership-guard', '');
    expect(none.allowed).toBe(false);
    expect(none.reason).toBe('no-authorized-marker');

    // A title that mentions the branch but allocates no VTID.
    expect(decide('dev-autopilot/78acafa6', 'Command Hub ownership guard fix').allowed).toBe(false);

    // A malformed / truncated VTID does not count as a real one.
    expect(decide('dev-autopilot/78acafa6', 'VTID-52: ownership guard fix').allowed).toBe(false);
  });

  it('(c) still FAILS a non dev-autopilot branch with an unlisted VTID', () => {
    const r = decide('claude/some-unrelated-branch', 'VTID-99999: unrelated Command Hub edit');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no-authorized-marker');
  });

  it('does not accept a dev-autopilot branch name appearing only in the PR title', () => {
    // The carve-out keys off the BRANCH, not the title — a mistyped title must
    // not turn into an authorization.
    expect(decide('claude/some-branch', 'dev-autopilot/VTID-04052: x').allowed).toBe(false);
  });

  it('anchors the branch pattern — a branch merely CONTAINING the marker does not qualify', () => {
    expect(decide('claude/dev-autopilot/VTID-04052-x', 'VTID-04052: x').allowed).toBe(false);
    expect(decide('feature/x-dev-autopilot/VTID-04052-x', 'VTID-04052: x').allowed).toBe(false);
  });

  it('is the only branch pattern the carve-out recognizes', () => {
    expect(guard.DEV_AUTOPILOT_EXECUTOR_BRANCH_PATTERN.test('dev-autopilot/78acafa6')).toBe(true);
    expect(guard.DEV_AUTOPILOT_EXECUTOR_BRANCH_PATTERN.test('dev-autopilot')).toBe(false);
    expect(guard.REAL_VTID_PATTERN.test('VTID-04052')).toBe(true);
    expect(guard.REAL_VTID_PATTERN.test('DEV-COMHU-0203')).toBe(false);
  });
});

describe('the guard still protects the Command Hub path itself', () => {
  it('defines the protected path the carve-out cannot widen', () => {
    expect(guard.PROTECTED_PATH).toBe('services/gateway/src/frontend/command-hub/');
  });

  it('explains in-source that the branch pattern is the executor’s and that VALIDATOR-CHECK is the real guarantee', () => {
    // The request explicitly asks for this rationale to be recorded next to the
    // check, so a future reader does not mistake the carve-out for a weakening
    // of Command Hub protection.
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../../../scripts/ci/command-hub-ownership-guard.js'),
      'utf8',
    );
    const block = src.slice(0, src.indexOf('const DEV_AUTOPILOT_EXECUTOR_BRANCH_PATTERN'));
    expect(block).toContain('VTID-04052');
    expect(block).toContain('Dev Autopilot agent');
    expect(block).toMatch(/VALIDATOR-CHECK/);
    expect(block).toMatch(/real governance guarantee/);
  });
});
