/**
 * VTID-05164 (C1) — a fixture AggregatorBatchAdapter for tests only.
 *
 * Phase 2 picks the aggregator vendor; C1 ships only the interface
 * (adapter.ts) and this fixture, which maps the simplest normalised event
 * shape ({ kind:'steps', start, end, value }) into one Health Sync v1 batch.
 * The v1 `source` block names a phone store; an aggregator adapter fills it
 * with the upstream store the vendor relays (a Phase 2 minor version may add
 * an aggregator source kind). Not imported by any production module.
 */
import type { AggregatorBatchAdapter } from '../adapter';
import type { HealthSyncBatchV1 } from '../contract-v1';

const FIXTURE_INSTALL_ID = '00000000-0000-4000-8000-00000000a99e';

export function createFixtureAggregatorAdapter(connectorId: string): AggregatorBatchAdapter {
  return {
    connector_id: connectorId,
    toBatch(events, ctx): HealthSyncBatchV1 | null {
      const records = events
        .filter((e) => e.kind === 'steps' && typeof e.start === 'string' && typeof e.end === 'string' && typeof e.value === 'number')
        .map((e) => ({
          record_id: `steps:${new Date(String(e.start)).toISOString()}`,
          type: 'steps',
          value: e.value as number,
          unit: '{steps}',
          start: String(e.start),
          end: String(e.end),
          tz: 'UTC',
        }));
      if (records.length === 0) return null;
      return {
        contract_version: '1.0',
        batch_id: ctx.batch_id,
        source: { kind: 'health_connect', install_id: FIXTURE_INSTALL_ID, platform: 'android', os_version: 'aggregator', app_version: connectorId },
        sync_mode: 'incremental',
        records,
        deletions: [],
      };
    },
  };
}
