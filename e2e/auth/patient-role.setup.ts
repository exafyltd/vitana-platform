import { test as setup } from '../fixtures/readonly-test'; // VTID-04730: login setup runs under the read-only role guard
import { loginAsRole, validateTestCredentials } from '../fixtures/test-users';

setup('authenticate as patient role', async ({ page }) => {
  validateTestCredentials();
  await loginAsRole(page, 'patient');
  await page.context().storageState({ path: '.auth/patient.json' });
});
