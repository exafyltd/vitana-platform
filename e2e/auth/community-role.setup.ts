import { test as setup } from '@playwright/test';
import { loginAsRole, validateTestCredentials } from '../fixtures/test-users';

setup('authenticate as community role', async ({ page }) => {
  validateTestCredentials();
  await loginAsRole(page, 'community');
  await page.context().storageState({ path: '.auth/community.json' });
});
