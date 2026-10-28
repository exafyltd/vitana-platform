import { HUB_ROUTES_BY_ROLE } from '../../../fixtures/routes';
import { createSmokeTests } from '../../../fixtures/smoke-helper';

createSmokeTests('Command Hub — Staff Role', HUB_ROUTES_BY_ROLE.staff);
