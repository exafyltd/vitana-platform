import { ROLE_GUARD_TEST_ROUTES } from '../../fixtures/routes';
import { createRoleGuardTests } from '../../fixtures/smoke-helper';

// Tests that a community-role user cannot access role-restricted routes.
// This spec runs in the desktop-shared project (uses community storageState).
createRoleGuardTests('Desktop — Role Guard', ROLE_GUARD_TEST_ROUTES);
