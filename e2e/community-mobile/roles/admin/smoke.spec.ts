import { COMMUNITY_ROUTES_BY_ROLE } from '../../../fixtures/routes';
import { createMobileSmokeTests } from '../../../fixtures/smoke-helper';

createMobileSmokeTests('Mobile — Admin Role', COMMUNITY_ROUTES_BY_ROLE.admin);
