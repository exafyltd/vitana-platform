/**
 * VTID-04432 — per-agent evaluation suites for the delegate_to_agent
 * specialists (docs/ORCHESTRATOR-REDESIGN-PLAN.md §5 P7), gated in CI by
 * this jest suite.
 *
 * AC-1 Every support-specialist case passes: scripted model, real entry point,
 *      real tool loop, real executor, two-user fixture store.
 * AC-2 Every commerce-specialist case passes the same way.
 * AC-3 The invariants hold on every case: reads pinned to the caller, no other
 *      user's data surfaced, tool budget kept, final call offered no tools,
 *      findings bounded with the "not a script" note, a signed-out caller
 *      never reaches the model, a failed run carries no result.
 * AC-4 The harness catches what it claims to: a deliberately unscoped
 *      specialist, a leaking one and an unbounded one each fail it.
 * AC-5 Every case id is unique and every case states what it checks.
 */

import { runSpecialistEval, runSpecialistEvalSuite, type SpecialistUnderEval } from '../../../src/services/orchestrator/evals/specialist-eval-harness';
import {
  SUPPORT_EVAL_CALLER,
  SUPPORT_EVAL_CASES,
  SUPPORT_EVAL_OTHER,
  SUPPORT_FAILING_LIST_CASES,
  supportUnderEval,
} from '../../../src/services/orchestrator/evals/support-specialist-evals';
import { COMMERCE_EVAL_CASES, COMMERCE_EVAL_OWNER, commerceUnderEval } from '../../../src/services/orchestrator/evals/commerce-specialist-evals';
import { runSupportSpecialist, SUPPORT_FINDINGS_MAX_CHARS } from '../../../src/services/orchestrator/support-specialist';

describe('VTID-04432 support specialist eval suite', () => {
  it.each(SUPPORT_EVAL_CASES.map((c) => [c.id, c] as const))('AC-1/AC-3 %s', async (_id, c) => {
    const agent = supportUnderEval({ failList: SUPPORT_FAILING_LIST_CASES.has(c.id) });
    const r = await runSpecialistEval(agent, c);
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('AC-3 the findings bound actually clipped the over-long answer', async () => {
    const c = SUPPORT_EVAL_CASES.find((x) => x.id === 'support.findings-bounded')!;
    const r = await runSpecialistEval(supportUnderEval(), c);
    const findings = (r.outcome.result as { findings: string }).findings;
    expect(findings.length).toBeLessThanOrEqual(SUPPORT_FINDINGS_MAX_CHARS + 1);
    expect(findings.endsWith('…')).toBe(true);
  });

  it('AC-3 the tool budget case ends with a tool-less call and six executed tools', async () => {
    const c = SUPPORT_EVAL_CASES.find((x) => x.id === 'support.tool-budget')!;
    const r = await runSpecialistEval(supportUnderEval(), c);
    expect(r.budgetExhausted).toBe(true);
    expect(r.toolsUsed).toHaveLength(6);
    expect(r.toolResults.some((t) => t.isError && t.result.includes('tool-call budget'))).toBe(true);
  });
});

describe('VTID-04432 commerce specialist eval suite', () => {
  it.each(COMMERCE_EVAL_CASES.map((c) => [c.id, c] as const))('AC-2/AC-3 %s', async (_id, c) => {
    const r = await runSpecialistEval(commerceUnderEval(), c);
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('AC-3 memberships are read once per run however many tools ask for them', async () => {
    const listCalls = { n: 0 };
    const c = COMMERCE_EVAL_CASES.find((x) => x.id === 'commerce.tool-budget')!;
    const r = await runSpecialistEval(commerceUnderEval(listCalls), c);
    expect(r.passed).toBe(true);
    expect(listCalls.n).toBe(1);
  });
});

describe('VTID-04432 suite summary', () => {
  it('AC-1/AC-2 both suites score 100%', async () => {
    const support = await runSpecialistEvalSuite(supportUnderEval(), SUPPORT_EVAL_CASES.filter((c) => !SUPPORT_FAILING_LIST_CASES.has(c.id)));
    const commerce = await runSpecialistEvalSuite(commerceUnderEval(), COMMERCE_EVAL_CASES);
    for (const s of [support, commerce]) {
      const failed = s.results.filter((r) => !r.passed).map((r) => `${r.id}: ${r.failures.join('; ')}`);
      expect(failed).toEqual([]);
      expect(s.passed).toBe(s.total);
    }
    // eslint-disable-next-line no-console
    console.log(`[specialist-evals] support ${support.passed}/${support.total}, commerce ${commerce.passed}/${commerce.total}`);
  });

  it('AC-5 case ids are unique and every case says what it checks', () => {
    const all = [...SUPPORT_EVAL_CASES, ...COMMERCE_EVAL_CASES];
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    for (const c of all) {
      expect(c.description.length).toBeGreaterThan(20);
      expect(c.script.length).toBeGreaterThan(0);
    }
    expect(SUPPORT_EVAL_CASES.length).toBeGreaterThanOrEqual(10);
    expect(COMMERCE_EVAL_CASES.length).toBeGreaterThanOrEqual(10);
  });
});

describe('VTID-04432 the harness catches broken specialists (mutation checks)', () => {
  const otherTicket = { ticket_number: 'FB-2026-07-000555', kind: 'account', status: 'resolved', created_at: '2026-07-09T08:00:00Z', resolved_at: null, resolution_md: 'OTHER-USER-SECRET-RESOLUTION', linked_vtid: 'VTID-09999' };

  function brokenSupport(mode: 'unscoped' | 'leak' | 'unbounded'): SpecialistUnderEval {
    const base = supportUnderEval();
    return {
      ...base,
      findingsMaxChars: mode === 'unbounded' ? 10 : base.findingsMaxChars,
      run: (request, caller, signal, runLoop, recordRead) =>
        runSupportSpecialist(request, caller, signal, {
          // unscoped: reads another member's rows; leak: returns them under the caller's id.
          listOpenTickets: async (uid) => { recordRead(mode === 'unscoped' ? SUPPORT_EVAL_OTHER : uid, 'list'); return [otherTicket]; },
          getOwnTicket: async (uid) => { recordRead(uid, 'get'); return otherTicket; },
          searchKnowledge: async () => [],
          runLoop,
        }),
    };
  }

  const listCase = SUPPORT_EVAL_CASES.find((c) => c.id === 'support.other-members-ticket')!;

  it('AC-4 an unscoped read fails the suite', async () => {
    const r = await runSpecialistEval(brokenSupport('unscoped'), { ...listCase, script: [{ tools: [{ name: 'list_my_tickets' }] }, { final: 'x' }], expect: { ok: true } });
    expect(r.passed).toBe(false);
    expect(r.failures.join('\n')).toMatch(new RegExp(`scoped to ${SUPPORT_EVAL_OTHER}`));
  });

  it("AC-4 another member's data surfacing fails the suite", async () => {
    const r = await runSpecialistEval(brokenSupport('leak'), listCase);
    expect(r.passed).toBe(false);
    expect(r.failures.join('\n')).toMatch(/another user's data surfaced/);
  });

  it('AC-4 findings over the bound fail the suite', async () => {
    const r = await runSpecialistEval(brokenSupport('unbounded'), { ...listCase, script: [{ final: 'y'.repeat(500) }], expect: { ok: true } });
    expect(r.passed).toBe(false);
    expect(r.failures.join('\n')).toMatch(/exceed 10/);
  });

  it('AC-4 a case expectation that does not hold is reported, not swallowed', async () => {
    const c = COMMERCE_EVAL_CASES.find((x) => x.id === 'commerce.list-organizations')!;
    const r = await runSpecialistEval(commerceUnderEval(), { ...c, userId: COMMERCE_EVAL_OWNER, expect: { ...c.expect, findingsContains: ['Rival Pharma'] } });
    expect(r.passed).toBe(false);
    expect(r.failures).toContain('findings lack "Rival Pharma"');
  });

  it('AC-4 fixtures really hold a second user (the leak checks are not vacuous)', () => {
    expect(SUPPORT_EVAL_OTHER).not.toBe(SUPPORT_EVAL_CALLER);
  });
});
