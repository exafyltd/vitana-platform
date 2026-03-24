import { test as setup } from '@playwright/test';
import { loginAsRole } from '../fixtures/test-users';

setup('authenticate as community role', async ({ page }) => {
  await loginAsRole(page, 'community');
  await page.context().storageState({ path: '.auth/community.json' });
});
