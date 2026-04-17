import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
const TEST_EMAIL = process.env.TEST_USER_EMAIL || 'e2e-test@vitana.dev';
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD || 'VitanaE2eTest2026!';

/**
 * Playwright globalSetup: provisions a dedicated E2E test user in Supabase.
 *
 * - Creates user if not exists (provision_platform_user trigger handles app_users + user_tenants)
 * - Updates password + app_metadata if user already exists
 * - Sets exafy_admin: true so the user can switch to any role
 * - Skips gracefully if SUPABASE_SERVICE_ROLE is not set (local dev fallback)
 */
export default async function globalSetup() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE;
  if (!serviceRoleKey) {
    console.log('[global-setup] SUPABASE_SERVICE_ROLE not set — skipping test user provisioning');
    return;
  }

  const supabase = createClient(SUPABASE_URL, serviceRoleKey);

  // Check if user already exists
  const { data: { users }, error: listError } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (listError) {
    console.error('[global-setup] Failed to list users:', listError.message);
    return;
  }

  const existing = users?.find(u => u.email === TEST_EMAIL);

  if (existing) {
    // Ensure password and admin metadata are correct
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      password: TEST_PASSWORD,
      app_metadata: { exafy_admin: true },
    });
    if (error) {
      console.error(`[global-setup] Failed to update test user: ${error.message}`);
      return;
    }
    console.log(`[global-setup] Test user ${TEST_EMAIL} updated (id: ${existing.id})`);
  } else {
    // Create user — provision_platform_user() trigger auto-creates app_users + user_tenants
    const { data, error } = await supabase.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { tenant_slug: 'maxina', display_name: 'E2E Test User' },
      app_metadata: { exafy_admin: true },
    });
    if (error) {
      throw new Error(`[global-setup] Failed to create test user: ${error.message}`);
    }
    console.log(`[global-setup] Test user ${TEST_EMAIL} created (id: ${data.user?.id})`);
  }
}
