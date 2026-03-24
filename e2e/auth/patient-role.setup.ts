import { test as setup } from '@playwright/test';
import { loginAsRole } from '../fixtures/test-users';

setup('authenticate as patient role', async ({ page }) => {
  await loginAsRole(page, 'patient');
  await page.context().storageState({ path: '.auth/patient.json' });
});
