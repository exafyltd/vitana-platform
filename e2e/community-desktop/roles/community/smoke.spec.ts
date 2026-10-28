import { COMMUNITY_ROUTES_BY_ROLE } from '../../../fixtures/routes';
import { createSmokeTests } from '../../../fixtures/smoke-helper';

createSmokeTests('Desktop — Community Role', COMMUNITY_ROUTES_BY_ROLE.community);
