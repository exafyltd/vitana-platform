/**
 * VTID-04002: Dev Autopilot PR contract — the deterministic layer that makes
 * an executor-opened PR pass VALIDATOR-CHECK.yml.
 *
 * The assertions below mirror the workflow's OWN checks (the grep/regex
 * shapes in .github/workflows/VALIDATOR-CHECK.yml), so a change to the
 * contract that would fail the real gate fails here first.
 */

import {
  applyPrContract,
  buildAcceptanceMarkdown,
  isTestFile,
  stampVtidOnTitle,
  type PrContractInput,
} from '../src/services/dev-autopilot-pr-contract';

const VTID_TITLE_RE = /VTID-[0-9]{4,5}/;
// `grep -Eo '^[[:space:]]*VTID:[[:space:]]*VTID-[0-9]{4,5}'` on the body.
const VTID_BODY_LINE_RE = /^[ \t]*VTID:[ \t]*VTID-[0-9]{4,5}/m;
// `grep -Eo 'VALIDATION_PROFILE:\s*[a-zA-Z0-9_/-]+'`
const PROFILE_RE = /VALIDATION_PROFILE:\s*[a-zA-Z0-9_/-]+/;
const OASIS_RE = /OASIS_IMPACT:\s*(yes|no)/;

/** Port of the workflow's Acceptance Mapping Gate python. */
function acceptanceMappingOk(md: string): { ok: boolean; reason?: string } {
  const txt = md.split('\n');
  const acIdx = txt.map((l, i) => (/^AC-\d+/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  if (acIdx.length === 0) return { ok: false, reason: 'no AC- entries' };
  for (const i of acIdx) {
    const window = txt.slice(i + 1, i + 13);
    if (!window.some((w) => /^(TEST:|CURL:|UI:)/.test(w.trim()))) {
      return { ok: false, reason: `AC at line ${i + 1} unmapped` };
    }
  }
  return { ok: true };
}

function baseInput(overrides: Partial<PrContractInput> = {}): PrContractInput {
  return {
    vtid: 'VTID-03955',
    title: 'DEV-AUTOPILOT: Fix memory scoring counts for domain-capped items',
    body: '## Summary\n\nFixes `included_count` in `scoreAndRankMemories()`.\n',
    files: [
      { path: 'services/gateway/src/services/memory-relevance-scoring.ts', action: 'modify' },
      { path: 'services/gateway/test/memory-relevance-scoring.test.ts', action: 'modify' },
    ],
    executionId: '0643b701-1111-2222-3333-444444444444',
    findingId: 'f1f1f1f1-1111-2222-3333-444444444444',
    planVersion: 1,
    branch: 'dev-autopilot/0643b701',
    baseBranch: 'main',
    provider: 'deepseek',
    model: 'deepseek-flash',
    now: '2026-09-17T12:00:00.000Z',
    ...overrides,
  };
}

describe('VTID-04002 stampVtidOnTitle', () => {
  it('appends the VTID in the repo convention when the title has none (the PR #3351 failure)', () => {
    const t = stampVtidOnTitle('DEV-AUTOPILOT: Fix memory scoring counts for domain-capped items', 'VTID-03955');
    expect(t).toBe('DEV-AUTOPILOT: Fix memory scoring counts for domain-capped items (VTID-03955)');
    expect(t).toMatch(VTID_TITLE_RE);
  });

  it('leaves a title that already carries a VTID untouched (never re-points the evidence gate)', () => {
    expect(stampVtidOnTitle('fix(x): thing (VTID-03900)', 'VTID-03955')).toBe('fix(x): thing (VTID-03900)');
  });

  it('keeps the stamped title under the GitHub title limit', () => {
    const long = 'x'.repeat(300);
    const t = stampVtidOnTitle(long, 'VTID-03955');
    expect(t.length).toBeLessThanOrEqual(240);
    expect(t.endsWith('(VTID-03955)')).toBe(true);
  });
});

describe('VTID-04002 applyPrContract — passes every VALIDATOR-CHECK text gate', () => {
  const out = applyPrContract(baseInput());

  it('title carries the VTID (exit 10 primary extraction + exit 90 merge gate)', () => {
    expect(out.title).toMatch(VTID_TITLE_RE);
    expect(out.title).toContain('VTID-03955');
  });

  it('body starts with an explicit "VTID: VTID-XXXXX" line (exit 10 body fallback)', () => {
    expect(out.body).toMatch(VTID_BODY_LINE_RE);
    expect(out.body.split('\n')[0]).toBe('VTID: VTID-03955');
  });

  it('body carries VALIDATION_PROFILE and all four markers (exit 11-15)', () => {
    expect(out.body).toMatch(PROFILE_RE);
    expect(out.body).toContain('VALIDATION_PROFILE: gateway_backend');
    for (const m of ['SCOPE_ALLOWLIST:', 'ACCEPTANCE:', 'MERGE_PAYLOAD_PREVIEW:', 'OASIS_IMPACT:']) {
      expect(out.body).toContain(m);
    }
    expect(out.body).toMatch(OASIS_RE);
    expect(out.body).toMatch(/OASIS_IMPACT:\s*no/);
  });

  it('keeps the model-authored body below the marker block', () => {
    expect(out.body).toContain('## Summary');
    expect(out.body.indexOf('VTID: VTID-03955')).toBeLessThan(out.body.indexOf('## Summary'));
  });

  it('emits the evidence pack the Evidence Pack Gate demands (exit 30-33)', () => {
    const paths = out.evidenceFiles.map((f) => f.path).sort();
    expect(paths).toEqual([
      'docs/validation/VTID-03955/acceptance.md',
      'docs/validation/VTID-03955/commands.log',
      'docs/validation/VTID-03955/outputs/execution.json',
    ]);
    for (const f of out.evidenceFiles) expect(f.content.length).toBeGreaterThan(0);
  });

  it('acceptance.md passes the Acceptance Mapping Gate (exit 40-41)', () => {
    const md = out.evidenceFiles.find((f) => f.path.endsWith('acceptance.md'))!.content;
    expect(acceptanceMappingOk(md)).toEqual({ ok: true });
  });

  it('maps the source file to its paired test file from the same diff', () => {
    const md = out.evidenceFiles.find((f) => f.path.endsWith('acceptance.md'))!.content;
    expect(md).toMatch(/AC-1 — `services\/gateway\/src\/services\/memory-relevance-scoring\.ts`/);
    expect(md).toMatch(/TEST: services\/gateway\/test\/memory-relevance-scoring\.test\.ts/);
  });

  it('records the serving provider/model and the execution ids in commands.log and outputs/', () => {
    const log = out.evidenceFiles.find((f) => f.path.endsWith('commands.log'))!.content;
    expect(log).toContain('provider=deepseek model=deepseek-flash');
    expect(log).toContain('execution_id=0643b701-1111-2222-3333-444444444444');
    const rec = JSON.parse(out.evidenceFiles.find((f) => f.path.endsWith('execution.json'))!.content);
    expect(rec.vtid).toBe('VTID-03955');
    expect(rec.files).toHaveLength(2);
    expect(rec.generated_at).toBe('2026-09-17T12:00:00.000Z');
  });

  it('SCOPE_ALLOWLIST lists every plan file plus the evidence directory', () => {
    const line = out.body.split('\n').find((l) => l.startsWith('SCOPE_ALLOWLIST:'))!;
    expect(line).toContain('services/gateway/src/services/memory-relevance-scoring.ts');
    expect(line).toContain('services/gateway/test/memory-relevance-scoring.test.ts');
    expect(line).toContain('docs/validation/VTID-03955/**');
  });

  it('is deterministic for the same input', () => {
    expect(applyPrContract(baseInput())).toEqual(applyPrContract(baseInput()));
  });
});

describe('VTID-04002 applyPrContract — edge cases', () => {
  it('does nothing (and says why) when the finding has no real VTID — a VTID-DA-xxxx id is not a ledger VTID', () => {
    const inp = baseInput({ vtid: null });
    const out = applyPrContract(inp);
    expect(out.title).toBe(inp.title);
    expect(out.body).toBe(inp.body);
    expect(out.evidenceFiles).toEqual([]);
    expect(out.skipped_reason).toMatch(/no real VTID/);
    expect(applyPrContract(baseInput({ vtid: 'VTID-DA-0643b701' })).skipped_reason).toBeDefined();
  });

  it('does not double-prepend markers when the model already wrote a complete validator block', () => {
    const body = [
      'VTID: VTID-03955',
      'VALIDATION_PROFILE: gateway_backend',
      'SCOPE_ALLOWLIST: a',
      'ACCEPTANCE: b',
      'MERGE_PAYLOAD_PREVIEW: c',
      'OASIS_IMPACT: no',
      '',
      '## Summary',
    ].join('\n');
    const out = applyPrContract(baseInput({ body }));
    expect(out.body).toBe(body);
    expect((out.body.match(/VALIDATION_PROFILE:/g) || []).length).toBe(1);
  });

  it('a source file with no paired test in the diff still gets a mapped AC (honest CI-suite mapping)', () => {
    const md = buildAcceptanceMarkdown({
      ...baseInput({ files: [{ path: 'services/gateway/src/services/foo.ts', action: 'modify' }] }),
      vtid: 'VTID-03955',
    });
    expect(acceptanceMappingOk(md)).toEqual({ ok: true });
    expect(md).toMatch(/TEST: services\/gateway full jest suite in CI/);
  });

  it('deletion-only diffs get an AC mapped to the build (tsc) gate', () => {
    const md = buildAcceptanceMarkdown({
      ...baseInput({ files: [{ path: 'services/gateway/src/services/dead.ts', action: 'delete' }] }),
      vtid: 'VTID-03955',
    });
    expect(acceptanceMappingOk(md)).toEqual({ ok: true });
    expect(md).toMatch(/AC-1 — the following file\(s\) are removed/);
  });

  it('isTestFile recognises this repo\'s test layouts', () => {
    expect(isTestFile('services/gateway/test/foo.test.ts')).toBe(true);
    expect(isTestFile('services/gateway/src/orb/live/__tests__/x.ts')).toBe(true);
    expect(isTestFile('src/foo.spec.tsx')).toBe(true);
    expect(isTestFile('services/gateway/src/services/foo.ts')).toBe(false);
    expect(isTestFile('services/gateway/src/services/testimonials.ts')).toBe(false);
  });
});

describe('VTID-04333 the member ticket number travels with the VTID', () => {
  const FB = 'FB-2026-09-000123';

  it('stamps the FB number next to the VTID on the title', () => {
    const t = stampVtidOnTitle('Fix the diary save button', 'VTID-04333', FB);
    expect(t).toBe(`Fix the diary save button (${FB}, VTID-04333)`);
    expect(VTID_TITLE_RE.test(t)).toBe(true);
  });

  it('adds only the id the title is missing', () => {
    expect(stampVtidOnTitle(`[${FB}] Fix x`, 'VTID-04333', FB)).toBe(`[${FB}] Fix x (VTID-04333)`);
    expect(stampVtidOnTitle('Fix x (VTID-04333)', 'VTID-04333', FB)).toBe(`Fix x (VTID-04333) (${FB})`);
    expect(stampVtidOnTitle(`Fix x (${FB}, VTID-04333)`, 'VTID-04333', FB)).toBe(`Fix x (${FB}, VTID-04333)`);
  });

  it('ignores a value that is not a ticket number', () => {
    expect(stampVtidOnTitle('Fix x', 'VTID-04333', 'feedback')).toBe('Fix x (VTID-04333)');
    expect(stampVtidOnTitle('Fix x', 'VTID-04333', null)).toBe('Fix x (VTID-04333)');
  });

  it('keeps a long title under the length cap with both ids', () => {
    const t = stampVtidOnTitle('x'.repeat(400), 'VTID-04333', FB);
    expect(t.length).toBeLessThanOrEqual(240);
    expect(t.endsWith(`(${FB}, VTID-04333)`)).toBe(true);
  });

  it('carries "Member report: FB-…" in the body and still passes the validator text gates', () => {
    const out = applyPrContract(baseInput({ vtid: 'VTID-04333', ticketNumber: FB }));
    expect(out.title).toContain(FB);
    expect(out.title).toContain('VTID-04333');
    expect(out.body).toContain(`Member report: ${FB}`);
    expect(out.body.match(/Member report:/g)).toHaveLength(1);
    expect(VTID_BODY_LINE_RE.test(out.body)).toBe(true);
    expect(PROFILE_RE.test(out.body)).toBe(true);
    const rec = JSON.parse(out.evidenceFiles.find((f) => f.path.endsWith('execution.json'))!.content);
    expect(rec.ticket_number).toBe(FB);
  });

  it('adds the member line to a model body that already carried the validator tokens', () => {
    const body = 'VTID: VTID-04333\nVALIDATION_PROFILE: gateway_backend\nSCOPE_ALLOWLIST: x\nACCEPTANCE: y\nMERGE_PAYLOAD_PREVIEW: z\nOASIS_IMPACT: no\n';
    const out = applyPrContract(baseInput({ vtid: 'VTID-04333', ticketNumber: FB, body }));
    expect(out.body.startsWith(`Member report: ${FB}\n\n`)).toBe(true);
    expect(VTID_BODY_LINE_RE.test(out.body)).toBe(true);
  });

  it('a non-ticket execution is unchanged', () => {
    const out = applyPrContract(baseInput());
    expect(out.body).not.toContain('Member report:');
    expect(out.title).not.toContain('FB-');
  });
});
