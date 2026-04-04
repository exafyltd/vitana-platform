import { test as setup } from '@playwright/test';
import { loginAsRole, validateTestCredentials } from '../fixtures/test-users';

setup('authenticate as admin role', async ({ page }) => {
  validateTestCredentials();
  await loginAsRole(page, 'admin');
  await page.context().storageState({ path: '.auth/admin.json' });
});
