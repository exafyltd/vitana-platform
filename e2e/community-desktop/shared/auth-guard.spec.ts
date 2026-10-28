import { AUTH_GUARD_TEST_ROUTES } from '../../fixtures/routes';
import { createAuthGuardTests } from '../../fixtures/smoke-helper';

// Tests that unauthenticated users are redirected to /auth for protected routes.
// Uses a fresh browser context with no stored session.
createAuthGuardTests('Desktop — Auth Guard', AUTH_GUARD_TEST_ROUTES);
