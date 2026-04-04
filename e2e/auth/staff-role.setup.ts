import { test as setup } from '@playwright/test';
import { loginAsRole, validateTestCredentials } from '../fixtures/test-users';

setup('authenticate as staff role', async ({ page }) => {
  validateTestCredentials();
  await loginAsRole(page, 'staff');
  await page.context().storageState({ path: '.auth/staff.json' });
});
