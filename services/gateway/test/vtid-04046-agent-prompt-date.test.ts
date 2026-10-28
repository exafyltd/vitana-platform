/**
 * VTID-04046: the agent executor's system prompt states today's date.
 *
 * The agent has no clock. Before this, any task needing a date (a Command Hub
 * cache-bust value, a dated evidence folder, a CHANGE LOG row) made it search
 * the repository for a recent-looking one. Measured live on Run #6b
 * (VTID-04045, execution 7e7260fe): turns 10-14 and 58 were date hunts — 6 of
 * the 60-turn budget — and the run still ended at the cap without finishing.
 */

import { buildAgentSystemPrompt, isoDay } from '../src/services/autopilot-agent/agent-prompt';

const base = {
  repo: 'exafyltd/vitana-platform',
  baseBranch: 'main',
  branch: 'dev-autopilot/abc12345',
  vtid: 'VTID-09999',
  allowScope: ['services/gateway/src/**'],
  denyScope: ['supabase/migrations/**'],
  conventions: '(conventions)',
  claudeMdExcerpt: '(rules)',
};

describe('VTID-04046 isoDay', () => {
  it('formats a Date as YYYY-MM-DD in UTC', () => {
    expect(isoDay(new Date('2026-09-18T08:19:09.930Z'))).toBe('2026-09-18');
    // Late UTC evening stays on its own UTC day rather than rolling forward.
    expect(isoDay(new Date('2026-09-18T23:59:59.000Z'))).toBe('2026-09-18');
    expect(isoDay(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01-05');
  });

  it('defaults to now, and the default is a well-formed day', () => {
    expect(isoDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('VTID-04046 buildAgentSystemPrompt states the date', () => {
  it('uses the supplied date and tells the agent not to search the repo for one', () => {
    const p = buildAgentSystemPrompt({ ...base, today: '2026-09-18' });
    expect(p).toContain('Today is 2026-09-18.');
    expect(p).toMatch(/never search the repository for one/i);
  });

  it('falls back to the runner clock when no date is supplied', () => {
    const p = buildAgentSystemPrompt(base);
    expect(p).toContain(`Today is ${isoDay()}.`);
  });

  it('states the date before the "How to work" section, so it is read as context not a step', () => {
    const p = buildAgentSystemPrompt({ ...base, today: '2026-09-18' });
    expect(p.indexOf('Today is 2026-09-18.')).toBeLessThan(p.indexOf('## How to work'));
    expect(p.indexOf('Today is 2026-09-18.')).toBeGreaterThan(-1);
  });

  it('changes nothing else about the prompt contract', () => {
    const p = buildAgentSystemPrompt({ ...base, today: '2026-09-18' });
    expect(p).toContain('exafyltd/vitana-platform');
    expect(p).toContain('VTID-09999');
    expect(p).toContain('services/gateway/src/**');
    expect(p).toContain('supabase/migrations/**');
    expect(p).toContain('## How to work');
    expect(p).toContain('run_check');
  });
});
