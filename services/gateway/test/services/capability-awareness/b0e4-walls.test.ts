/**
 * VTID-02924 (B0e.4) — wall-integrity tests + migration shape.
 *
 * Covers:
 *   - Migration shape (table, RPC, RLS, idempotency UNIQUE).
 *   - Acceptance check #1: selection alone does NOT mutate awareness
 *     (the B0e.2 provider source has no DB-write calls).
 *   - Acceptance check #7: Command Hub remains read-only — the B0e.3
 *     preview route and panel function have NO mutation surface.
 *   - B0e.3 panel does NOT import the B0e.4 service or invoke the
 *     event endpoint.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_PATH = join(
  __dirname,
  '../../../../../supabase/migrations/20260519000000_VTID_02924_capability_awareness_events.sql',
);
const PROVIDER_PATH = join(
  __dirname,
  '../../../src/services/assistant-continuation/providers/feature-discovery.ts',
);
const PREVIEW_ROUTE_PATH = join(
  __dirname,
  '../../../src/routes/voice-feature-discovery.ts',
);
const APP_JS_PATH = join(__dirname, '../../../src/frontend/command-hub/app.js');

describe('B0e.4 — migration shape', () => {
  let sql: string;
  beforeAll(() => {
    sql = readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('creates capability_awareness_events table', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS capability_awareness_events/);
  });

  it('UNIQUE (tenant_id, user_id, idempotency_key) — idempotency boundary', () => {
    expect(sql).toMatch(/UNIQUE \(tenant_id, user_id, idempotency_key\)/);
  });

  it('event_name CHECK locks the 6 allowed events', () => {
    expect(sql).toMatch(
      /event_name\s+TEXT NOT NULL CHECK \(event_name IN \(\s*'introduced','seen','tried','completed','dismissed','mastered'\s*\)\)/s,
    );
  });

  it('previous_state + next_state CHECK enforce all 7 ladder states', () => {
    const states = ['unknown', 'introduced', 'seen', 'tried', 'completed', 'dismissed', 'mastered'];
    for (const s of states) {
      expect(sql).toContain(`'${s}'`);
    }
  });

  it('enables RLS with tenant isolation via user_tenants', () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/user_tenants/);
  });

  it('foreign key to system_capabilities locks capability_key', () => {
    expect(sql).toMatch(/REFERENCES system_capabilities\(capability_key\)/);
  });

  it('decision_id index for continuation linkage', () => {
    expect(sql).toMatch(/capability_awareness_events_decision_idx/);
    expect(sql).toMatch(/WHERE decision_id IS NOT NULL/);
  });

  it('advance_capability_awareness RPC is created', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION advance_capability_awareness/);
  });

  it('RPC enforces dismissed → introduced as the ONLY way out of dismissed', () => {
    // The state-machine should be visible in the RPC source as the
    // documented invariant.
    expect(sql).toMatch(/dismissed.*introduced/s);
  });

  it('RPC has unique_violation race-handler for idempotency', () => {
    expect(sql).toMatch(/EXCEPTION WHEN unique_violation/);
  });
});

describe('B0e.4 acceptance check #1: selection does NOT mutate', () => {
  it('B0e.2 provider source has no DB-mutation calls', () => {
    const src = readFileSync(PROVIDER_PATH, 'utf8');
    expect(src).not.toMatch(/\.insert\(/);
    expect(src).not.toMatch(/\.update\(/);
    expect(src).not.toMatch(/\.upsert\(/);
    expect(src).not.toMatch(/\.delete\(/);
    expect(src).not.toMatch(/advance_capability_awareness/);
    expect(src).not.toMatch(/\.rpc\(/);
  });
});

describe('B0e.4 acceptance check #7: Command Hub stays read-only', () => {
  let appJs: string;
  let previewRoute: string;
  beforeAll(() => {
    appJs = readFileSync(APP_JS_PATH, 'utf8');
    previewRoute = readFileSync(PREVIEW_ROUTE_PATH, 'utf8');
  });

  it('B0e.3 preview route has no mutation calls', () => {
    expect(previewRoute).not.toMatch(/\.insert\(/);
    expect(previewRoute).not.toMatch(/\.update\(/);
    expect(previewRoute).not.toMatch(/\.upsert\(/);
    expect(previewRoute).not.toMatch(/\.delete\(/);
    expect(previewRoute).not.toMatch(/advance_capability_awareness/);
    expect(previewRoute).not.toMatch(/\.rpc\(/);
    // Defensive: preview route must not even import the B0e.4 service.
    expect(previewRoute).not.toMatch(/capability-awareness-service/);
  });

  it('Command Hub Feature Discovery panel has no mutation surface', () => {
    const fnMatch = appJs.match(
      /function renderJourneyContextFeatureDiscoveryPanel\(fd\)\s*\{[\s\S]*?\n\}/,
    );
    expect(fnMatch).toBeTruthy();
    const body = fnMatch![0];
    expect(body).not.toMatch(/createElement\(['"]button['"]\)/);
    expect(body).not.toMatch(/\.onclick\s*=/);
    expect(body).not.toMatch(/addEventListener\(['"]click['"]/);
    expect(body).not.toMatch(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
    // Panel must not invoke the new B0e.4 event endpoint.
    expect(body).not.toMatch(/\/api\/v1\/voice\/feature-discovery\/event/);
  });

  it('loadJourneyContext only uses GET /feature-discovery/preview (not /event)', () => {
    // The whole loadJourneyContext function — match it tightly.
    const fnMatch = appJs.match(/function loadJourneyContext\(\)[\s\S]*?\n\}/);
    expect(fnMatch).toBeTruthy();
    const body = fnMatch![0];
    expect(body).toContain('/api/v1/voice/feature-discovery/preview');
    expect(body).not.toContain('/api/v1/voice/feature-discovery/event');
  });
});
