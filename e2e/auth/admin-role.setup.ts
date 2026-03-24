import { test as setup } from '@playwright/test';
import { loginAsRole } from '../fixtures/test-users';

setup('authenticate as admin role', async ({ page }) => {
  await loginAsRole(page, 'admin');
  await page.context().storageState({ path: '.auth/admin.json' });
});
