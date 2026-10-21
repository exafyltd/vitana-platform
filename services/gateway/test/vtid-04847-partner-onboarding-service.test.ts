/**
 * VTID-04847 — the onboarding service authorizes every caller itself (the
 * routes skip the repeat check only after their own middleware ran), and
 * flags a company change that would void a passed verification.
 */
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }) }));
import { changeVoidsVerification, getOnboardingStatus, submitForVerification } from '../src/services/partner-onboarding-service';

function fakeSupabase(role: string | null) {
  const calls: string[] = [];
  const s: any = {
    from: (table: string) => {
      calls.push(table);
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: table === 'partner_organization_members' && role ? { role } : null, error: null }),
      };
      return q;
    },
  };
  return { s, calls };
}

describe('authorization is part of every service call', () => {
  test('a member who is not org_admin is refused before anything is read', async () => {
    const { s, calls } = fakeSupabase('staff');
    const r = await submitForVerification(s, { userId: 'u-1' }, 'org-1');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, error: 'NOT_ORG_ADMIN' });
    expect(calls).toEqual(['partner_organization_members']);
  });

  test('a stranger is refused too', async () => {
    const { s } = fakeSupabase(null);
    expect((await getOnboardingStatus(s, { userId: 'u-2' }, 'org-1')).status).toBe(403);
  });

  test('the routes, already checked by their middleware, skip the repeat lookup', async () => {
    const { s, calls } = fakeSupabase(null);
    await getOnboardingStatus(s, { userId: 'u-1', orgAdminChecked: true }, 'org-1');
    expect(calls).not.toContain('partner_organization_members');
  });
});

describe('changes that void a passed verification', () => {
  const passed = { steps: [{ key: 'verification', required: true, status: 'done' }] } as any;
  const open = { steps: [{ key: 'verification', required: true, status: 'todo' }] } as any;
  test.each([
    [passed, ['website'], true],
    [passed, ['vat_id'], true],
    [passed, ['country'], true],
    [passed, ['legal_name'], false],
    [open, ['website'], false],
    [null, ['website'], false],
  ])('%#', (checklist, fields, voids) => {
    expect(changeVoidsVerification(checklist, fields as string[])).toBe(voids);
  });
});
