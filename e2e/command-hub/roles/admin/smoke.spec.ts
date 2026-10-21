import { HUB_ROUTES_BY_ROLE } from '../../../fixtures/routes';
import { createSmokeTests } from '../../../fixtures/smoke-helper';

createSmokeTests('Command Hub — Admin Role', HUB_ROUTES_BY_ROLE.admin);
