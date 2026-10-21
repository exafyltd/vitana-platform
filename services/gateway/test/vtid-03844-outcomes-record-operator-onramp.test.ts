/**
 * VTID-03844 — dev_autopilot_outcomes records operator on-ramp findings.
 *
 * recordOutcome() early-returned for any finding whose source_type was not
 * `dev_autopilot` / `dev_autopilot_impact` — a hard-coded copy of the
 * original pair that predates the executor-lane allowlist
 * (autopilot-executable-source-types.ts, VTID-02984) and the on-ramp
 * (`operator_onramp`, VTID-03820). Observed on staging 2026-09-13: a real
 * approved + executed on-ramp finding produced zero outcome rows.
 *
 * The table's CHECK constraint carried the same pair, so the fix is two
 * halves — the code gate now uses isExecutableSourceType(), and migration
 * 20260913100000_vtid_03844_outcomes_source_type_allowlist.sql widens the
 * CHECK. The last test pins the two lists against each other so they cannot
 * drift apart again.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EXECUTABLE_RECOMMENDATION_SOURCE_TYPES } from '../src/services/autopilot-executable-source-types';

const SUPA_URL = 'https://supa.test';
const SUPA_KEY = 'service-role-key';

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

// SUPABASE_URL / SUPABASE_SERVICE_ROLE are read at module load, so the env
// must be in place before the module is required.
type OutcomesModule = typeof import('../src/services/dev-autopilot-outcomes');
let outcomes: OutcomesModule;

beforeAll(() => {
  process.env.SUPABASE_URL = SUPA_URL;
  process.env.SUPABASE_SERVICE_ROLE = SUPA_KEY;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    outcomes = require('../src/services/dev-autopilot-outcomes');
  });
});

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

const FINDING_ID = 'f1a2b3c4-0000-4000-8000-000000000001';

function rigFinding(row: Record<string, unknown> | null) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/rest/v1/autopilot_recommendations?id=eq.')) {
      return jsonRes(200, row ? [row] : []);
    }
    if (url.endsWith('/rest/v1/dev_autopilot_outcomes') && init?.method === 'POST') {
      return jsonRes(201, null);
    }
    throw new Error(`unexpected fetch ${init?.method || 'GET'} ${url}`);
  });
}

function outcomeInsertBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/rest/v1/dev_autopilot_outcomes') && (init as RequestInit)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

describe('VTID-03844 — recordOutcome accepts every executor-lane source_type', () => {
  it('records an outcome row for an operator_onramp finding (the case observed missing on staging)', async () => {
    rigFinding({
      source_type: 'operator_onramp',
      risk_class: 'low',
      impact_score: 3,
      effort_score: 1,
      spec_snapshot: { files_referenced: ['services/gateway/test/x.test.ts'] },
    });
    await outcomes.recordOutcome({ finding_id: FINDING_ID, decision: 'approved', vtid: 'VTID-03829' });
    const bodies = outcomeInsertBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      finding_id: FINDING_ID,
      source_type: 'operator_onramp',
      scanner_name: 'unknown',
      decision: 'approved',
      vtid: 'VTID-03829',
      risk_class: 'low',
      impact_score: 3,
      effort_score: 1,
    });
  });

  it.each(['dev_autopilot', 'dev_autopilot_impact'])('still records the legacy %s source_type', async (source_type) => {
    rigFinding({ source_type, risk_class: null, impact_score: null, effort_score: null, spec_snapshot: { scanner: 'smell-x' } });
    await outcomes.recordOutcome({ finding_id: FINDING_ID, decision: 'auto_exec' });
    const bodies = outcomeInsertBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ source_type, scanner_name: 'smell-x', decision: 'auto_exec' });
  });

  it('still skips a non-executable source_type — no INSERT is attempted', async () => {
    rigFinding({ source_type: 'community_health_scan', risk_class: null, impact_score: null, effort_score: null, spec_snapshot: null });
    await outcomes.recordOutcome({ finding_id: FINDING_ID, decision: 'approved' });
    expect(outcomeInsertBodies()).toHaveLength(0);
  });

  it('skips a null source_type and a missing finding', async () => {
    rigFinding({ source_type: null, risk_class: null, impact_score: null, effort_score: null, spec_snapshot: null });
    await outcomes.recordOutcome({ finding_id: FINDING_ID, decision: 'approved' });
    expect(outcomeInsertBodies()).toHaveLength(0);

    rigFinding(null);
    await outcomes.recordOutcome({ finding_id: FINDING_ID, decision: 'approved' });
    expect(outcomeInsertBodies()).toHaveLength(0);
  });
});

describe('VTID-03844 — the DB CHECK constraint mirrors the executor-lane allowlist', () => {
  it('migration 20260913100000 lists exactly EXECUTABLE_RECOMMENDATION_SOURCE_TYPES', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../../../supabase/migrations/20260913100000_vtid_03844_outcomes_source_type_allowlist.sql'),
      'utf8',
    );
    // Anchor on the ADD CONSTRAINT body — the file's header comment quotes
    // the OLD two-value CHECK, which must not be what gets compared.
    const m = sql.match(/ADD CONSTRAINT dev_autopilot_outcomes_source_type_check\s+CHECK \(source_type IN \(([\s\S]*?)\)\)/);
    expect(m).not.toBeNull();
    const inDb = m![1].match(/'([^']+)'/g)!.map((s) => s.replace(/'/g, '')).sort();
    expect(inDb).toEqual([...EXECUTABLE_RECOMMENDATION_SOURCE_TYPES].sort());
    expect(inDb).toContain('operator_onramp');
  });
});
