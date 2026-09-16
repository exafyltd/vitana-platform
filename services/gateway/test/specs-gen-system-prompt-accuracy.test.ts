/**
 * VTID-03934: SPEC_GEN_SYSTEM_PROMPT contained stale/wrong facts that were
 * faithfully reproduced in generated specs, plus no guardrail against
 * inventing a VTID number as a "coordination risk."
 *
 * Found while evaluating Command Hub Operator's real-world spec-generation
 * quality (VTID-03931, a test task run through the live Operator chat +
 * planner-sweep pipeline). The generated spec's Risk section cited:
 *   "VTID-03573 (in_progress, INFRA layer) is actively modifying internal
 *   auth flows"
 * — verified via a whole-repo grep that VTID-03573 does not exist anywhere
 * in this codebase. It also described the deploy path as "GitHub Actions
 * EXEC-DEPLOY.yml -> Cloud Run source deploy" and the frontend bundle as
 * "~30k lines" — both traced back to this exact hardcoded system prompt
 * (services/gateway/src/routes/specs.ts), not to the model's own
 * reasoning: GCP/Cloud Run was fully decommissioned 2026-08-16 (this
 * repo's own CLAUDE.md banner), and `wc -l` on the real file showed
 * 56,112 lines, not ~30k.
 *
 * These tests pin the corrected prompt content directly (SPEC_GEN_SYSTEM_PROMPT
 * is now exported specifically so this can be asserted without needing a
 * live LLM call or mocking callClaudeText's captured `system` argument).
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || 'test-service-role';

import { SPEC_GEN_SYSTEM_PROMPT } from '../src/routes/specs';

describe('SPEC_GEN_SYSTEM_PROMPT — accuracy fixes (VTID-03934)', () => {
  it('no longer describes EXEC-DEPLOY.yml/Cloud Run as the live deploy mechanism', () => {
    expect(SPEC_GEN_SYSTEM_PROMPT).not.toMatch(/Cloud Run source deploy/);
    // EXEC-DEPLOY.yml may still be named, but only as an explicitly dead/
    // decommissioned path to avoid — never as "Deploy via ... EXEC-DEPLOY.yml"
    expect(SPEC_GEN_SYSTEM_PROMPT).not.toMatch(/Deploy via GitHub Actions EXEC-DEPLOY\.yml/);
  });

  it('describes the real AWS ECS staging-first deploy path instead', () => {
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/AWS-STAGE-DEPLOY-GATEWAY\.yml/);
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/AWS-PROD-DEPLOY-GATEWAY\.yml/);
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/vitana-gateway-awsdr/);
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/PUBLISH button/);
  });

  it('explicitly flags GCP/Cloud Run as decommissioned rather than silently omitting it', () => {
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/decommissioned/i);
  });

  it('no longer states the stale "~30k lines" app.js line count', () => {
    expect(SPEC_GEN_SYSTEM_PROMPT).not.toMatch(/~30k lines/);
  });

  it('does not replace the stale figure with another hardcoded line count that will just go stale again', () => {
    // The real count (56,112 at the time this was fixed) will drift as the
    // file grows — asserting a qualitative description instead of a
    // number is the actual fix, not a coincidence of when this ran.
    expect(SPEC_GEN_SYSTEM_PROMPT).not.toMatch(/\b\d[\d,]*k?\s*lines\b/i);
  });

  it('describes the gateway as running on AWS ECS, not "on Cloud Run"', () => {
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/AWS ECS/);
    expect(SPEC_GEN_SYSTEM_PROMPT).not.toMatch(/backend API on Cloud Run/);
  });

  it('adds an explicit output rule forbidding a fabricated VTID coordination-risk citation', () => {
    // Must instruct the model to only cite a VTID that verbatim appears in
    // the SYSTEM CONTEXT section of the task message, and to describe risk
    // generically when no related VTID is present there.
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/NEVER cite a specific VTID number/i);
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/SYSTEM CONTEXT/);
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/describe the risk or dependency generically/i);
  });

  it('the new VTID-citation rule is appended to (not replacing) the existing 7 output rules', () => {
    const outputRulesSection = SPEC_GEN_SYSTEM_PROMPT.split('## Output Rules')[1]?.split('## Required Spec Structure')[0] || '';
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(outputRulesSection).toMatch(new RegExp(`^${n}\\.`, 'm'));
    }
  });

  it('still contains the required spec structure section headings, unaffected by the fact corrections', () => {
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/## 1\. Goal/);
    expect(SPEC_GEN_SYSTEM_PROMPT).toMatch(/## 9\. Risk Level/);
  });
});
