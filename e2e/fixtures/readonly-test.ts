/**
 * VTID-04689 — a read-only run never saves the shared test account's role.
 *
 * Every project signs in as the same account. When the Command Hub loads for
 * a user whose saved role it does not allow, it saves `developer` on the
 * server (app.js setActiveRole on boot). Under E2E_READONLY=1 that was the one
 * write the "read-only" suite still made — and it flipped the account the
 * community projects use, so "community user blocked from admin route" ran as
 * a developer and failed (measured 2026-09-28: role_preferences set to
 * developer at 11:16:36, 4 s into a read-only run).
 *
 * Under E2E_READONLY=1 every page blocks the two role-saving calls: the
 * gateway's POST /api/v1/me/active-role and the Supabase RPCs
 * set_role_preference / me_set_active_role. Reads pass through. The Command
 * Hub already treats a failed save as non-fatal and keeps the role locally.
 */
import { test as base, expect, type BrowserContext } from '@playwright/test';

export const READONLY_ROLE_WRITE_PATTERNS: RegExp[] = [
  /\/api\/v1\/me\/active-role(?:[?#]|$)/,
  /\/rest\/v1\/rpc\/(?:set_role_preference|me_set_active_role)(?:[?#]|$)/,
];

export function isReadonlyRoleWrite(url: string, method: string): boolean {
  if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD') return false;
  return READONLY_ROLE_WRITE_PATTERNS.some((re) => re.test(url));
}

export async function installReadonlyRoleWriteGuard(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const req = route.request();
    if (isReadonlyRoleWrite(req.url(), req.method())) return route.abort('blockedbyclient');
    return route.fallback();
  });
}

export const test = base.extend<{ readonlyRoleWriteGuard: void }>({
  readonlyRoleWriteGuard: [
    async ({ context }, use) => {
      if (process.env.E2E_READONLY === '1') await installReadonlyRoleWriteGuard(context);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
