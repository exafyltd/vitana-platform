import { test as setup } from '../fixtures/readonly-test'; // VTID-04730: login setup runs under the read-only role guard
import { loginAsRole, validateTestCredentials } from '../fixtures/test-users';

setup('authenticate as professional role', async ({ page }) => {
  validateTestCredentials();
  await loginAsRole(page, 'professional');
  await page.context().storageState({ path: '.auth/professional.json' });
});
