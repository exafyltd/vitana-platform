// BOOTSTRAP-VALIDATOR-LOCAL-PREFLIGHT — unit tests for the local PR-body
// pre-flight tool that mirrors VALIDATOR-CHECK.yml's `validate-pr` job.
//
// Built after PR #3330 (VTID-03933) and PR #3332 (VTID-03934) each needed a
// full CI round-trip to discover a pure PR-body formatting miss — a
// mutation-verification note that said "Verified manually:" instead of
// leading with the required `TEST:` token (exit 41), and an `OASIS_IMPACT:`
// line written as prose instead of the literal `yes`/`no` token the gate's
// regex requires (exit 80). These tests pin that this tool (a) reproduces
// those exact two real failures locally, and (b) approves the corrected
// bodies that actually shipped — so the tool is proven against the real
// incident, not just a made-up fixture.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('node:child_process', () => ({
  execFileSync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFileSync } = require('node:child_process') as { execFileSync: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  validate,
  extractVtid,
  grepAwkSecondField,
  checkAcceptanceMapping,
} = require('../../../../scripts/ci/validate-pr-locally.cjs');

const VTID = 'VTID-99999';

function setupWorkdir(vtid = VTID) {
  const root = mkdtempSync(join(tmpdir(), 'validate-pr-locally-'));
  const evid = join(root, 'docs', 'validation', vtid);
  mkdirSync(join(evid, 'outputs'), { recursive: true });
  return { root, evid };
}

function writeAcceptance(evid: string, content: string) {
  writeFileSync(join(evid, 'acceptance.md'), content);
}

function writeCommandsLog(evid: string) {
  writeFileSync(join(evid, 'commands.log'), '# commands\n');
}

function mockGit(changedFiles: string[], scopedDiff = '') {
  execFileSync.mockReset();
  execFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === 'fetch') return '';
    if (cmd === 'git' && args[0] === 'diff' && args[1] === '--name-only') {
      return changedFiles.join('\n');
    }
    if (cmd === 'git' && args[0] === 'diff') {
      return scopedDiff;
    }
    return '';
  });
}

const GOOD_MARKERS = [
  'VALIDATION_PROFILE: gateway_backend',
  'SCOPE_ALLOWLIST: services/gateway/src/foo.ts',
  'ACCEPTANCE: see acceptance.md',
  'MERGE_PAYLOAD_PREVIEW: trivial change',
  'OASIS_IMPACT: no',
].join('\n');

function goodBody(overrides = '') {
  return `${GOOD_MARKERS}\n${overrides}`;
}

function goodAcceptance() {
  return [
    'AC-1 — does the thing',
    '',
    'TEST: `test/foo.test.ts`',
    'Output: outputs/foo.txt',
  ].join('\n');
}

describe('validate-pr-locally — PR-body/metadata gates', () => {
  afterEach(() => {
    execFileSync.mockReset();
  });

  describe('title/body presence (exit 2)', () => {
    it('rejects an empty title', () => {
      const { root } = setupWorkdir();
      const r = validate({ title: '', body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(2);
    });

    it('rejects an empty body', () => {
      const { root } = setupWorkdir();
      const r = validate({ title: `${VTID}: fix`, body: '  ', base: 'main', root, runBuild: false });
      expect(r.code).toBe(2);
    });
  });

  describe('VTID extraction (exit 10)', () => {
    it('rejects when neither title nor a VTID: body line has one', () => {
      const { root } = setupWorkdir();
      const r = validate({ title: 'Fix a bug', body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(10);
    });

    it('accepts a VTID from the title', () => {
      expect(extractVtid(`${VTID}: fix`, '')).toBe(VTID);
    });

    it('falls back to an explicit VTID: line in the body, not a prose mention', () => {
      expect(extractVtid('Fix a bug', `VTID: ${VTID}`)).toBe(VTID);
      // VTID-03696's own fix: a prose mention must NOT be picked up.
      expect(extractVtid('Fix a bug', `see also ${VTID} for background`)).toBeNull();
    });
  });

  describe('VALIDATION_PROFILE extraction (exit 11)', () => {
    it('rejects when missing entirely', () => {
      const { root } = setupWorkdir();
      const body = goodBody().replace('VALIDATION_PROFILE: gateway_backend\n', '');
      const r = validate({ title: `${VTID}: fix`, body, base: 'main', root, runBuild: false });
      expect(r.code).toBe(11);
    });

    it('rejects when the colon has no separating space (awk $2 is empty)', () => {
      // Mirrors the workflow's `grep -Eo ... | awk '{print $2}'` idiom exactly.
      expect(grepAwkSecondField('VALIDATION_PROFILE:gateway_backend', /VALIDATION_PROFILE:\s*[a-zA-Z0-9_/-]+/)).toBe('');
    });

    it('extracts the profile when properly spaced', () => {
      expect(
        grepAwkSecondField('VALIDATION_PROFILE: gateway_backend', /VALIDATION_PROFILE:\s*[a-zA-Z0-9_/-]+/),
      ).toBe('gateway_backend');
    });
  });

  describe('required markers (exit 12-15)', () => {
    const cases: [string, number][] = [
      ['SCOPE_ALLOWLIST:', 12],
      ['ACCEPTANCE:', 13],
      ['MERGE_PAYLOAD_PREVIEW:', 14],
      ['OASIS_IMPACT:', 15],
    ];
    it.each(cases)('rejects when %s is missing (exit %i)', (marker, code) => {
      const { root } = setupWorkdir();
      const body = GOOD_MARKERS.split('\n')
        .filter((l) => !l.startsWith(marker))
        .join('\n');
      const r = validate({ title: `${VTID}: fix`, body, base: 'main', root, runBuild: false });
      expect(r.code).toBe(code);
    });
  });

  describe('changed files (exit 16)', () => {
    it('rejects when the diff is empty', () => {
      const { root } = setupWorkdir();
      mockGit([]);
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(16);
    });
  });

  describe('path ownership guard (delegated to validator-path-guard.cjs)', () => {
    it('propagates an unknown-profile rejection (exit 21)', () => {
      const { root } = setupWorkdir();
      const body = goodBody().replace('VALIDATION_PROFILE: gateway_backend', 'VALIDATION_PROFILE: nonsense_profile');
      mockGit(['services/gateway/src/foo.ts']);
      const r = validate({ title: `${VTID}: fix`, body, base: 'main', root, runBuild: false });
      expect(r.code).toBe(21);
    });
  });

  describe('evidence pack gate (exit 30-33)', () => {
    it('rejects a missing evidence dir', () => {
      const root = mkdtempSync(join(tmpdir(), 'validate-pr-locally-empty-'));
      mockGit(['services/gateway/src/foo.ts']);
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(30);
    });

    it('rejects a missing acceptance.md', () => {
      const { root } = setupWorkdir();
      mockGit(['services/gateway/src/foo.ts']);
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(31);
    });

    it('rejects a missing commands.log', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(evid, goodAcceptance());
      mockGit(['services/gateway/src/foo.ts']);
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(32);
    });

    it('rejects a missing outputs/ dir', () => {
      const root = mkdtempSync(join(tmpdir(), 'validate-pr-locally-nooutputs-'));
      const evid = join(root, 'docs', 'validation', VTID);
      mkdirSync(evid, { recursive: true });
      writeAcceptance(evid, goodAcceptance());
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts']);
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(33);
    });
  });

  describe('acceptance mapping gate (exit 40-41) — the real VTID-03933/03934 incident', () => {
    it('checkAcceptanceMapping() directly reproduces the exact reported CI failure: "Verified manually:" is not a TEST:/CURL:/UI: token', () => {
      // Byte-for-byte the shape that failed on PR #3330 (VTID-03933) before the fix.
      const { root, evid } = setupWorkdir();
      writeAcceptance(
        evid,
        [
          'AC-7 — mutation-verified: reverting the fix reproduces the bug',
          '',
          'Verified manually: git stash, re-ran the tests, they failed, restored.',
        ].join('\n'),
      );
      const { code, messages } = checkAcceptanceMapping(join(evid, 'acceptance.md'));
      expect(code).toBe(41);
      expect(messages.some((m: string) => /AC at line 1 has no TEST/.test(m))).toBe(true);
      rmSync(root, { recursive: true, force: true });
    });

    it('rejects via the full validate() pipeline when an AC has no TEST:/CURL:/UI: within 12 lines', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(
        evid,
        [
          'AC-7 — mutation-verified: reverting the fix reproduces the bug',
          '',
          'Verified manually: git stash, re-ran the tests, they failed, restored.',
        ].join('\n'),
      );
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts']);
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(41);
      expect(r.messages.some((m: string) => /AC at line 1 has no TEST/.test(m))).toBe(true);
    });

    it('rejects when acceptance.md has no AC- entries at all', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(evid, 'No acceptance criteria written yet.');
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts']);
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(40);
    });

    it('approves the corrected wording that actually shipped (leads with TEST:)', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(
        evid,
        [
          'AC-7 — mutation-verified: reverting the fix reproduces the bug',
          '',
          'TEST: manual mutation check — git stash, re-ran the tests, they failed, restored.',
        ].join('\n'),
      );
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts']);
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(0);
    });
  });

  describe('OASIS traceability gate (exit 80-81) — the real VTID-03933/03934 incident', () => {
    it('reproduces the exact reported CI failure: prose instead of the literal yes/no token', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(evid, goodAcceptance());
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts']);
      const body = goodBody().replace(
        'OASIS_IMPACT: no',
        'OASIS_IMPACT: None — pure logic change with no OASIS event emission',
      );
      const r = validate({ title: `${VTID}: fix`, body, base: 'main', root, runBuild: false });
      expect(r.code).toBe(80);
    });

    it('approves the corrected literal token that actually shipped', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(evid, goodAcceptance());
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts']);
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(0);
    });

    it('requires OASIS_PROOF: in acceptance.md when OASIS_IMPACT: yes', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(evid, goodAcceptance());
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts']);
      const body = goodBody().replace('OASIS_IMPACT: no', 'OASIS_IMPACT: yes');
      const r = validate({ title: `${VTID}: fix`, body, base: 'main', root, runBuild: false });
      expect(r.code).toBe(81);
    });

    it('approves OASIS_IMPACT: yes when OASIS_PROOF: is present', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(evid, `${goodAcceptance()}\n\nOASIS_PROOF: oasis_events row abc123`);
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts']);
      const body = goodBody().replace('OASIS_IMPACT: no', 'OASIS_IMPACT: yes');
      const r = validate({ title: `${VTID}: fix`, body, base: 'main', root, runBuild: false });
      expect(r.code).toBe(0);
    });
  });

  describe('CSP governance gate (exit 50)', () => {
    it('rejects a CSP-pattern hit in an added line under the CSP surface', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(evid, goodAcceptance());
      writeCommandsLog(evid);
      execFileSync.mockReset();
      execFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === 'fetch') return '';
        if (args[0] === 'diff' && args[1] === '--name-only') {
          return 'services/gateway/src/frontend/command-hub/app.js';
        }
        if (args[0] === 'diff') {
          return '+++ b/services/gateway/src/frontend/command-hub/app.js\n+document.write("<script>alert(1)</script>");';
        }
        return '';
      });
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(50);
    });
  });

  describe('merge deploy gate (exit 90-91)', () => {
    it('rejects when the title does not literally contain the VTID resolved from the body', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(evid, goodAcceptance());
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts']);
      const body = `VTID: ${VTID}\n${goodBody()}`;
      const r = validate({ title: 'Fix a bug (no VTID in title)', body, base: 'main', root, runBuild: false });
      expect(r.code).toBe(90);
    });
  });

  describe('the full happy path', () => {
    it('approves a well-formed PR end to end and prints the PASS summary', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(evid, goodAcceptance());
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts', `docs/validation/${VTID}/acceptance.md`]);
      const r = validate({ title: `${VTID}: fix a thing`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.code).toBe(0);
      expect(r.messages).toContain('APPROVED');
      expect(r.messages).toContain(`VTID=${VTID}`);
      expect(r.messages).toContain('PROFILE=gateway_backend');
    });

    it('skips the Build Gate by default and says so', () => {
      const { root, evid } = setupWorkdir();
      writeAcceptance(evid, goodAcceptance());
      writeCommandsLog(evid);
      mockGit(['services/gateway/src/foo.ts']);
      const r = validate({ title: `${VTID}: fix`, body: goodBody(), base: 'main', root, runBuild: false });
      expect(r.messages.some((m: string) => /Build Gate SKIPPED/.test(m))).toBe(true);
    });
  });
});
