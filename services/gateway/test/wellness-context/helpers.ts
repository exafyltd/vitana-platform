/**
 * VTID-05165 — fixtures for the wellness context tests. Port fakes only
 * (round-1 F3): A's S10 fake (createFakeHealthStore) runs the real S3/S4
 * logic in memory; no test imports A's repositories or internal types.
 */
import { randomUUID } from 'crypto';
import { createFakeHealthStore, type FakeHealthStore } from '../../src/services/health-store/testing/fake-health-store';
import type { GatewayLocale } from '../../src/i18n/catalog';
import type { WellnessContextDeps, WellnessIdentity } from '../../src/services/wellness-context';

export const NOW = new Date('2026-10-13T12:00:00.000Z');
/** The reference date buildWellnessContext uses at NOW (last complete UTC day). */
export const AS_OF = '2026-10-12';
export const ME: WellnessIdentity = { tenant_id: '11111111-1111-4111-8111-111111111111', user_id: '22222222-2222-4222-8222-222222222222' };

const DAY_MS = 24 * 60 * 60 * 1000;

/** AS_OF minus `n` days. */
export function daysBefore(n: number, base = AS_OF): string {
  return new Date(Date.parse(`${base}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
}

export interface Harness {
  store: FakeHealthStore;
  deps: WellnessContextDeps;
  reads: unknown[];
  consentChecks: Array<{ key: string; resource: string | null }>;
  setEnabled(on: boolean): void;
  setLocale(l: GatewayLocale): void;
  phoneSource: string;
}

export function createHarness(): Harness {
  const store = createFakeHealthStore({ clock: () => NOW });
  const phoneSource = store.addSource({ tenant_id: ME.tenant_id, user_id: ME.user_id, kind: 'phone_store', connector_id: 'apple_health' });
  const reads: unknown[] = [];
  const consentChecks: Array<{ key: string; resource: string | null }> = [];
  let enabled = true;
  let locale: GatewayLocale = 'de';
  const deps: WellnessContextDeps = {
    enabled: () => enabled,
    hasConsent: (identity, key, resource) => {
      consentChecks.push({ key, resource: resource ?? null });
      return store.deps.hasConsent(identity, key, resource);
    },
    readDailyObservations: (identity, o) => {
      reads.push(o);
      return store.readDailyObservations(null, identity, o);
    },
    getLocale: async () => locale,
    now: () => NOW,
  };
  return {
    store,
    deps,
    reads,
    consentChecks,
    phoneSource,
    setEnabled(on) {
      enabled = on;
    },
    setLocale(l) {
      locale = l;
    },
  };
}

/** Grants everything a full wellness context needs on Apple Health. */
export function grantAll(h: Harness) {
  h.store.grantConsent(ME, 'ai_health_analysis');
  h.store.grantConsent(ME, 'sync_sleep', 'apple_health');
  h.store.grantConsent(ME, 'sync_activity', 'apple_health');
}

/**
 * Seeds `days` days ending on AS_OF through A's real write path (S3):
 * a sleep session (record) and an hour-aligned steps interval (series_sum)
 * per day. `sleep(i)` / `steps(i)` give the value for i days before AS_OF
 * (null = no data that day).
 */
export async function seed(
  h: Harness,
  days: number,
  sleep: (i: number) => number | null,
  steps: (i: number) => number | null,
) {
  const samples = [];
  for (let i = 0; i < days; i++) {
    const date = daysBefore(i);
    const s = sleep(i);
    if (s !== null) {
      const start = `${date}T01:00:00.000Z`;
      samples.push({ source_record_id: `sleep-${date}`, code: 'sleep_session', unit: 'min', start, end: new Date(Date.parse(start) + s * 60_000).toISOString(), value: s });
    }
    const st = steps(i);
    if (st !== null) {
      const start = `${date}T13:00:00.000Z`;
      samples.push({ source_record_id: `steps:${start}`, code: 'steps', unit: '{steps}', start, end: new Date(Date.parse(start) + 5 * 60_000).toISOString(), value: st });
    }
  }
  // The store refuses unconsented samples (S7), so the ingest consents are granted for the write.
  h.store.grantConsent(ME, 'sync_sleep', 'apple_health');
  h.store.grantConsent(ME, 'sync_activity', 'apple_health');
  const res = await h.store.writeHealthSamples(null, { identity: ME, source_id: h.phoneSource, batch_id: randomUUID(), via: 'internal', tz: 'UTC', samples, deletions: [] });
  if (!res.ok) throw new Error(`seed failed: ${JSON.stringify(res)}`);
  const bad = res.results.filter((r) => r.status !== 'stored');
  if (bad.length > 0) throw new Error(`seed rejected: ${JSON.stringify(bad.slice(0, 3))}`);
}
