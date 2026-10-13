/**
 * VTID-05164 — shared fixtures for the Health Sync tests. Port fakes only
 * (round-1 F3): A's S10 fake (createFakeHealthStore) and an S6 fake of B's
 * resolveHealthSource; no test imports A's or B's repositories.
 */
import { randomUUID } from 'crypto';
import type { CicdOasisEvent } from '../../src/types/cicd';
import { createFakeHealthStore, type FakeHealthStore } from '../../src/services/health-store/testing/fake-health-store';
import type { HealthSyncDeps, HealthSyncIdentity } from '../../src/services/health-sync/adapter';

export const NOW = new Date('2026-10-13T12:00:00.000Z');
export const ME: HealthSyncIdentity = { tenant_id: '11111111-1111-4111-8111-111111111111', user_id: '22222222-2222-4222-8222-222222222222' };
export const OTHER: HealthSyncIdentity = { tenant_id: '11111111-1111-4111-8111-111111111111', user_id: '33333333-3333-4333-8333-333333333333' };
export const INSTALL_ID = '0b7f6d52-3a1e-4c2f-8d9a-1e2f3a4b5c6d';

/** An aligned 5-minute interval start, `minutesAgo` before NOW (UTC ISO). */
export function interval(minutesAgo: number): string {
  const FIVE = 5 * 60 * 1000;
  return new Date(Math.floor((NOW.getTime() - minutesAgo * 60 * 1000) / FIVE) * FIVE).toISOString();
}

export function stepsRecord(minutesAgo: number, value: number) {
  const start = interval(minutesAgo);
  const end = new Date(Date.parse(start) + 5 * 60 * 1000).toISOString();
  return { record_id: `steps:${start}`, type: 'steps', value, unit: '{steps}', start, end, tz: 'Europe/Berlin' };
}

export function sleepRecord(id: string, minutes: number) {
  return {
    record_id: id,
    type: 'sleep_session',
    value: minutes,
    unit: 'min',
    start: '2026-10-12T22:00:00Z',
    end: '2026-10-13T06:00:00Z',
    tz: 'Europe/Berlin',
    stages: [
      { stage: 'light', start: '2026-10-12T22:00:00Z', end: '2026-10-13T01:00:00Z' },
      { stage: 'deep', start: '2026-10-13T01:00:00Z', end: '2026-10-13T06:00:00Z' },
    ],
  };
}

export function weightRecord(id: string, kg: number, unit = 'kg') {
  return { record_id: id, type: 'body_weight', value: kg, unit, start: '2026-10-13T07:00:00+02:00', end: '2026-10-13T07:00:00+02:00', tz: 'Europe/Berlin' };
}

export function validBatch(over: Record<string, unknown> = {}) {
  return {
    contract_version: '1.0',
    batch_id: '6f1c2b1e-4d6a-4a8e-9c1b-2f3e4d5a6b7c',
    source: { kind: 'apple_health', install_id: INSTALL_ID, platform: 'ios', os_version: '18.1', app_version: '1.0.0' },
    sync_mode: 'incremental',
    records: [
      { record_id: 'steps:2026-10-13T08:00:00.000Z', type: 'steps', value: 412, unit: '{steps}', start: '2026-10-13T08:00:00Z', end: '2026-10-13T08:05:00Z', tz: 'Europe/Berlin' },
    ],
    deletions: [],
    ...over,
  };
}

/** S6 fake of B's resolveHealthSource / setHealthSourceState, registering sources in A's fake. */
export function createFakeSources(store: FakeHealthStore) {
  type Row = { source_id: string; identity: HealthSyncIdentity; kind: string; connector_id: string | null; provider_user_id: string | null; status: string };
  const rows: Row[] = [];
  let mode: 'ok' | 'STORE_PENDING' | 'STORE_UNAVAILABLE' = 'ok';
  const calls: unknown[] = [];
  return {
    rows,
    calls,
    setMode(m: typeof mode) {
      mode = m;
    },
    async resolve(identity: HealthSyncIdentity, input: any) {
      calls.push(input);
      if (mode !== 'ok') return { ok: false as const, code: mode };
      const found = rows.find(
        (r) => r.identity.user_id === identity.user_id && r.identity.tenant_id === identity.tenant_id && r.kind === input.kind &&
          r.connector_id === (input.connector_id ?? null) && r.provider_user_id === (input.provider_user_id ?? null),
      );
      if (found) return { ok: true as const, source_id: found.source_id, kind: found.kind as any, connector_id: found.connector_id, status: found.status as any };
      if (!input.create || input.kind !== 'phone_store') return { ok: false as const, code: 'SOURCE_NOT_CONNECTED' as const };
      const source_id = randomUUID();
      rows.push({ source_id, identity, kind: input.kind, connector_id: input.connector_id, provider_user_id: input.provider_user_id, status: 'connected' });
      store.addSource({ source_id, tenant_id: identity.tenant_id, user_id: identity.user_id, kind: 'phone_store', connector_id: input.connector_id });
      return { ok: true as const, source_id, kind: 'phone_store' as const, connector_id: input.connector_id, status: 'connected' as const };
    },
    addAggregator(identity: HealthSyncIdentity, connector_id: string, provider_user_id: string, status = 'connected') {
      const source_id = randomUUID();
      rows.push({ source_id, identity, kind: 'aggregator', connector_id, provider_user_id, status });
      store.addSource({ source_id, tenant_id: identity.tenant_id, user_id: identity.user_id, kind: 'aggregator', connector_id, status: status as any });
      return source_id;
    },
    setStatus(source_id: string, status: string) {
      const r = rows.find((x) => x.source_id === source_id);
      if (r) r.status = status;
    },
  };
}

export function createHarness() {
  const store = createFakeHealthStore({ clock: () => NOW });
  const sources = createFakeSources(store);
  const events: CicdOasisEvent[] = [];
  const writes: unknown[] = [];
  const logs: Array<Record<string, unknown>> = [];
  let consentReads = 0;
  const deps: HealthSyncDeps = {
    resolveSource: (identity, input) => sources.resolve(identity, input),
    findConsentId: async (identity, key, resource) => {
      consentReads++;
      return store.deps.findConsentId(identity, key, resource);
    },
    writeHealthSamples: async (input) => {
      writes.push(JSON.parse(JSON.stringify(input)));
      return store.writeHealthSamples(null, input);
    },
    emit: async (e) => {
      events.push(e);
      return { ok: true };
    },
    log: (l) => {
      logs.push(l);
    },
  };
  return { store, sources, deps, events, writes, logs, consentReads: () => consentReads };
}
