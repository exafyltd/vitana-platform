/**
 * VTID-05164 (Health Hub Phase 1 / C1): the two phone health stores.
 *
 * Apple Health (HealthKit) and Health Connect hold their data on the member's
 * phone. There is no OAuth, no token, no webhook and no server-side fetch: the
 * native app reads the store on the device (after the member's consent and the
 * OS permission) and sends Health Sync v1 batches to POST /api/v1/health/ingest
 * (services/health-sync/contract-v1.ts). These registry entries exist so that
 *   - the connector id is a known resource for the `sync_*` consents
 *     (routes/health-consent.ts, HEALTH_SYNC_SOURCE_KINDS), and
 *   - `health_sources.connector_id` can reference `connector_registry(id)`
 *     (rows seeded by 20261014130000_vtid_05164_health_sync_consent_keys.sql).
 *
 * auth_type `sdk_bridge`: the data arrives through the native SDK bridge.
 */

import type { Connector } from '../types';

const CAPABILITIES = ['activity.read', 'sleep.read', 'heart.read', 'body.read'];

export const appleHealthConnector: Connector = {
  id: 'apple_health',
  category: 'health_store',
  display_name: 'Apple Health',
  auth_type: 'sdk_bridge',
  capabilities: CAPABILITIES,
};

export const healthConnectConnector: Connector = {
  id: 'health_connect',
  category: 'health_store',
  display_name: 'Health Connect',
  auth_type: 'sdk_bridge',
  capabilities: CAPABILITIES,
};
