import { test as setup } from '@playwright/test';
import { loginAsRole } from '../fixtures/test-users';

setup('authenticate as staff role', async ({ page }) => {
  await loginAsRole(page, 'staff');
  await page.context().storageState({ path: '.auth/staff.json' });
});
