/**
 * VTID-05023 part 4: the gateway's own writes for a brand-new member run as
 * service_role, which the Aurora db-pre-request hook never provisions. These
 * paths run right after sign-up (first login, profile, invite claim, Vitana ID
 * onboarding card, tenant invitation accept, admin repair) and must await
 * ensureProvisioned() BEFORE their first read/write of the member's rows.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', 'src', 'routes');

const PATHS: Array<{ file: string; handler: string; before: string }> = [
  { file: 'auth.ts', handler: "router.post('/login'", before: 'repo.fetchPrimaryTenantMembership(supabase, uid)' },
  { file: 'auth.ts', handler: "router.get('/me'", before: 'repo.fetchMeProfile(supabase, identity.user_id)' },
  { file: 'auth.ts', handler: "router.put('/profile'", before: 'repo.updateAppUserProfile(' },
  { file: 'community-invites.ts', handler: "router.post('/claim'", before: 'claimInvite(sb, identity.user_id' },
  { file: 'users-vitana-id.ts', handler: "router.get('/me/vitana-id/suggestion'", before: 'repo.fetchProfileForSuggestion(' },
  { file: 'users-vitana-id.ts', handler: "router.post('/me/vitana-id/confirm'", before: 'repo.fetchProfileForConfirm(' },
  { file: 'tenant-admin/invitations.ts', handler: "acceptRouter.post('/accept/:token'", before: 'repo.insertUserTenantMembership(' },
  { file: 'admin-signups.ts', handler: "router.post('/:id/repair'", before: 'repo.fetchAppUserByUserId(' },
];

describe('VTID-05023 ensureProvisioned on post-sign-up write paths', () => {
  it.each(PATHS)('$file $handler awaits ensureProvisioned before its first member write', ({ file, handler, before }) => {
    const src = readFileSync(join(SRC, file), 'utf8');
    expect(src).toMatch(/import \{ ensureProvisioned \} from '(\.\.\/)+services\/auth-bridge\/auth-bridge';/);
    const start = src.indexOf(handler);
    expect(start).toBeGreaterThanOrEqual(0);
    const call = src.indexOf('await ensureProvisioned(', start);
    const target = src.indexOf(before, start);
    expect(call).toBeGreaterThan(start);
    expect(target).toBeGreaterThan(call);
  });
});
