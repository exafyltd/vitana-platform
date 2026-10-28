import { test, expect } from '@playwright/test';
import { installReadonlyRoleWriteGuard } from '../fixtures/readonly-test';
const URLS = [
  ['https://preview-aws-gateway.vitanaland.com/api/v1/me/active-role', 'POST'],
  ['https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/rpc/set_role_preference', 'POST'],
  ['https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/rpc/me_set_active_role', 'POST'],
  ['https://preview-aws-gateway.vitanaland.com/api/v1/me/active-role', 'GET'],
  ['https://preview-aws-gateway.vitanaland.com/api/v1/me/context', 'GET'],
  ['https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/rpc/get_my_permitted_roles', 'POST'],
] as const;
async function run(page, context, guard: boolean) {
  // Everything is answered locally, so only the guard can make a request fail.
  await context.route('**/*', (r) => r.fulfill({ status: 200, body: '{}', contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }));
  if (guard) await installReadonlyRoleWriteGuard(context);
  await page.goto('https://example.test/');
  return page.evaluate(async (urls) => {
    const out: string[] = [];
    for (const [u, m] of urls) {
      try { const r = await fetch(u, { method: m }); out.push(`${r.status}`); } catch { out.push('BLOCKED'); }
    }
    return out;
  }, URLS as any);
}
test('with the guard: role saves blocked, reads and other writes pass', async ({ page, context }) => {
  expect(await run(page, context, true)).toEqual(['BLOCKED', 'BLOCKED', 'BLOCKED', '200', '200', '200']);
});
test('without the guard (control): every request reaches the stub', async ({ page, context }) => {
  expect(await run(page, context, false)).toEqual(['200', '200', '200', '200', '200', '200']);
});
