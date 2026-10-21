/**
 * VTID-04005: execution ownership across the shared staging/prod table.
 */

import { claimStamp, filterOwnedExecutions, ownsExecution, CLAIMED_ENV_KEY } from '../src/services/dev-autopilot-env-ownership';

describe('VTID-04005 ownsExecution', () => {
  it('treats an unstamped (legacy) row as owned by every environment', () => {
    expect(ownsExecution(null, 'staging')).toBe(true);
    expect(ownsExecution({}, 'production')).toBe(true);
    expect(ownsExecution({ other: 1 }, 'production')).toBe(true);
  });

  it('owns a row stamped with its own environment and refuses the other', () => {
    expect(ownsExecution({ [CLAIMED_ENV_KEY]: 'staging' }, 'staging')).toBe(true);
    expect(ownsExecution({ [CLAIMED_ENV_KEY]: 'staging' }, 'production')).toBe(false);
    expect(ownsExecution({ [CLAIMED_ENV_KEY]: 'production' }, 'staging')).toBe(false);
  });

  it('ignores a non-string stamp', () => {
    expect(ownsExecution({ [CLAIMED_ENV_KEY]: 42 }, 'staging')).toBe(true);
  });
});

describe('VTID-04005 claimStamp / filterOwnedExecutions', () => {
  it('stamps the current env and an ISO claimed_at', () => {
    const st = claimStamp(new Date('2026-09-17T17:00:00Z'));
    expect(st.claimed_env === 'staging' || st.claimed_env === 'production').toBe(true);
    expect(st.claimed_at).toBe('2026-09-17T17:00:00.000Z');
  });

  it('keeps owned + legacy rows and drops the other environment\'s (the Run #2 incident shape)', () => {
    const rows = [
      { id: 'aaaaaaaa-1', metadata: { [CLAIMED_ENV_KEY]: 'staging' } },
      { id: 'bbbbbbbb-2', metadata: { [CLAIMED_ENV_KEY]: 'production' } },
      { id: 'cccccccc-3', metadata: null },
    ];
    const prodView = filterOwnedExecutions(rows, '[t]', 'production').map((r) => r.id);
    expect(prodView).toEqual(['bbbbbbbb-2', 'cccccccc-3']);
    const stagingView = filterOwnedExecutions(rows, '[t]', 'staging').map((r) => r.id);
    expect(stagingView).toEqual(['aaaaaaaa-1', 'cccccccc-3']);
  });
});
