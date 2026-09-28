/**
 * VTID-04666 — health analyzer env checks: ANTHROPIC_API_KEY is deliberately
 * absent (Bedrock-only, VTID-03563) and is never recommended; the GitHub
 * requirement is satisfied by GITHUB_SAFE_MERGE_TOKEN, which the gateway uses.
 */

import {
  checkEnvGaps,
  INTENTIONALLY_ABSENT_ENV_VARS,
  REQUIRED_ENV_VARS,
} from '../src/services/recommendation-engine/analyzers/health-analyzer';

const base = { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE: 'y' } as NodeJS.ProcessEnv;

describe('checkEnvGaps', () => {
  it('never reports ANTHROPIC_API_KEY, and it is documented as intentionally absent', () => {
    const gaps = checkEnvGaps({ ...base, GITHUB_SAFE_MERGE_TOKEN: 't' });
    expect(gaps.map((g) => g.variable)).not.toContain('ANTHROPIC_API_KEY');
    expect(INTENTIONALLY_ABSENT_ENV_VARS.ANTHROPIC_API_KEY).toMatch(/Bedrock/);
    expect(REQUIRED_ENV_VARS.map((v) => v.name)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('GITHUB_SAFE_MERGE_TOKEN alone satisfies the GitHub requirement (no GITHUB_TOKEN card)', () => {
    expect(checkEnvGaps({ ...base, GITHUB_SAFE_MERGE_TOKEN: 't' })).toEqual([]);
  });

  it('GITHUB_TOKEN still satisfies it as an alias', () => {
    expect(checkEnvGaps({ ...base, GITHUB_TOKEN: 't' })).toEqual([]);
  });

  it('with no GitHub token at all the gap names the variable the gateway actually reads', () => {
    const gaps = checkEnvGaps({ ...base });
    expect(gaps.map((g) => g.variable)).toEqual(['GITHUB_SAFE_MERGE_TOKEN']);
  });

  it('still reports genuinely missing required vars', () => {
    const gaps = checkEnvGaps({ GITHUB_SAFE_MERGE_TOKEN: 't' } as NodeJS.ProcessEnv);
    expect(gaps.map((g) => g.variable).sort()).toEqual(['SUPABASE_SERVICE_ROLE', 'SUPABASE_URL']);
  });
});
