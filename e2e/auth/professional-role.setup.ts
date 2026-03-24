import { test as setup } from '@playwright/test';
import { loginAsRole } from '../fixtures/test-users';

setup('authenticate as professional role', async ({ page }) => {
  await loginAsRole(page, 'professional');
  await page.context().storageState({ path: '.auth/professional.json' });
});
