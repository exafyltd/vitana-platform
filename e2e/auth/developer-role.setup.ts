import { test as setup } from '@playwright/test';
import { loginAsRole, validateTestCredentials } from '../fixtures/test-users';

setup('authenticate as developer role', async ({ page }) => {
  validateTestCredentials();
  await loginAsRole(page, 'developer');
  await page.context().storageState({ path: '.auth/developer.json' });
});
