import { test as setup } from '@playwright/test';
import { loginAsRole, validateTestCredentials } from '../fixtures/test-users';

setup('authenticate as patient role', async ({ page }) => {
  validateTestCredentials();
  await loginAsRole(page, 'patient');
  await page.context().storageState({ path: '.auth/patient.json' });
});
