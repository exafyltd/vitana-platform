/**
 * VTID-04572 — the [USER IDENTITY] block reads name/birthday from `profiles`
 * and locale from `app_users`. It used to select every column from
 * `app_users`, which has no first_name/date_of_birth, so every call failed
 * and the brain never knew the member's name or birthday.
 */
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'service-role-test';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({})) }));
jest.mock('../../src/services/identity-guardrail-block-repository', () => ({
  fetchProfileIdentityRow: jest.fn(),
  fetchAppUserIdentityRow: jest.fn(),
}));

import * as repo from '../../src/services/identity-guardrail-block-repository';
import { buildIdentityGuardrailBlock } from '../../src/services/identity-guardrail-block';

const profileRow = repo.fetchProfileIdentityRow as jest.Mock;
const appUserRow = repo.fetchAppUserIdentityRow as jest.Mock;

beforeEach(() => {
  profileRow.mockReset();
  appUserRow.mockReset();
});

describe('buildIdentityGuardrailBlock (VTID-04572)', () => {
  it('puts the profile name and birth date into the block', async () => {
    profileRow.mockResolvedValue({
      data: { first_name: 'Dragan', last_name: 'S', display_name: null, date_of_birth: '1969-09-09', gender: 'male', city: 'Berlin', country: 'DE' },
      error: null,
    });
    appUserRow.mockResolvedValue({ data: { locale: 'de' }, error: null });
    const block = await buildIdentityGuardrailBlock({ user_id: 'u1' });
    expect(block).toContain('- Name: Dragan S');
    expect(block).toContain('- Date of birth: 1969-09-09');
    expect(block).toContain('- Locale: de');
    expect(block).toContain('- Location: Berlin, DE');
  });

  it('keeps the profile identity when the app_users read fails', async () => {
    profileRow.mockResolvedValue({ data: { first_name: 'Dragan', date_of_birth: '1969-09-09' }, error: null });
    appUserRow.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const block = await buildIdentityGuardrailBlock({ user_id: 'u1' });
    expect(block).toContain('- Name: Dragan');
    expect(block).toContain('- Date of birth: 1969-09-09');
    expect(block).not.toContain('Locale');
  });

  it('returns an empty block when neither table has a row', async () => {
    profileRow.mockResolvedValue({ data: null, error: null });
    appUserRow.mockResolvedValue({ data: null, error: null });
    expect(await buildIdentityGuardrailBlock({ user_id: 'u1' })).toBe('');
  });
});

describe('identity-guardrail-block-repository queries the right tables', () => {
  const real = jest.requireActual('../../src/services/identity-guardrail-block-repository');
  function stub() {
    const calls: any[] = [];
    const q: any = {
      select: (c: string) => { calls.push(['select', c]); return q; },
      eq: () => q, maybeSingle: async () => ({ data: null, error: null }),
    };
    return { calls, sb: { from: (t: string) => { calls.push(['from', t]); return q; } } };
  }
  it('profile fields come from profiles', async () => {
    const s = stub();
    await real.fetchProfileIdentityRow(s.sb, 'u1');
    expect(s.calls[0]).toEqual(['from', 'profiles']);
    expect(s.calls[1][1]).toContain('date_of_birth');
  });
  it('app_users is only asked for locale', async () => {
    const s = stub();
    await real.fetchAppUserIdentityRow(s.sb, 'u1');
    expect(s.calls).toEqual([['from', 'app_users'], ['select', 'locale']]);
  });
});
