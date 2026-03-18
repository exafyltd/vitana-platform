/**
 * Automation Handlers — Registration index
 *
 * VTID: VTID-01250
 * Imports all domain handlers and registers them with the executor.
 */

import { registerConnectPeopleHandlers } from './connect-people';
import { registerCommunityGroupsHandlers } from './community-groups';
import { registerSharingGrowthHandlers } from './sharing-growth';
import { registerHealthWellnessHandlers } from './health-wellness';
import { registerWalletPaymentsHandlers } from './wallet-payments';
import { registerBusinessMarketplaceHandlers } from './business-marketplace';
import { registerLiveRoomsCommerceHandlers } from './live-rooms-commerce';
import { registerEngagementEventsHandlers } from './engagement-events';
import { registerHandler } from '../automation-executor';

/**
 * Register ALL automation handlers.
 * Call once during gateway initialization.
 */
export function registerAllAutomationHandlers(): void {
  console.log('[Automations] Registering all automation handlers...');

  registerConnectPeopleHandlers();
  registerCommunityGroupsHandlers();
  registerSharingGrowthHandlers();
  registerHealthWellnessHandlers();
  registerWalletPaymentsHandlers();
  registerBusinessMarketplaceHandlers();
  registerLiveRoomsCommerceHandlers();
  registerEngagementEventsHandlers();

  console.log('[Automations] All handlers registered.');
}
