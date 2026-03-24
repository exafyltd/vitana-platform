import { test as setup } from '@playwright/test';
import { loginAsRole } from '../fixtures/test-users';

setup('authenticate as developer role', async ({ page }) => {
  await loginAsRole(page, 'developer');
  await page.context().storageState({ path: '.auth/developer.json' });
});
