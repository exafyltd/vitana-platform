/**
 * VTID-04797: Jev P2 gate A8 — near-duplicate check for a new Dev Autopilot
 * finding against live findings on the same file. Shadow only.
 */
const rows: any[] = [];
jest.mock('../src/services/jev/jev-repository', () => ({
  insertShadowDecision: jest.fn(async (_sb: unknown, row: any) => {
    rows.push({ ...row, id: `s${rows.length + 1}` });
    return { data: { id: `s${rows.length}` }, error: null };
  }),
}));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));

import * as fs from 'fs';
import * as path from 'path';
import { findingText, isFindingDedupeOn, MAX_CANDIDATES, runFindingDedupeCheck, type FindingLike } from '../src/services/jev/gates/finding-dedupe-gate';
import { createMemoryJevControl, setDefaultJevControlForTest } from '../src/services/jev/jev-tenant-control';

const JEV_ON = { JEV_DECISIONS_ENABLED: 'true', TYPESAFE_API_KEY: 'k' };
const SHADOW = { ...JEV_ON, JEV_FINDING_DEDUPE_MODE: 'shadow' };
const sb = {} as any;

const FILE = 'services/gateway/src/routes/orb-live.ts';
const NEW: FindingLike = { id: 'new-1', title: 'Missing tests for orb-live.ts', summary: 'No unit tests cover connectToLiveAPI', signal_type: 'missing_tests', file_path: FILE };
const C1: FindingLike = { id: 'old-1', title: 'Large file: orb-live.ts', summary: '19,000 lines', signal_type: 'large_file', file_path: FILE };
const C2: FindingLike = { id: 'old-2', title: 'Untested route handler in orb-live.ts', summary: 'connectToLiveAPI has no test', signal_type: 'safety_gap', file_path: FILE };

function deps(fresh: FindingLike | null, candidates: FindingLike[]) {
  return {
    loadNew: jest.fn(async () => fresh),
    loadCandidates: jest.fn(async (_f: string, _x: string, limit: number) => candidates.slice(0, limit)),
  };
}
function dup(p: number) {
  return { ok: true, model: 'jev-1.13.0', answers: { duplicate: { type: 'noul', noul: p } }, usage: { input_tokens: 300, output_tokens: 1 }, latency_ms: 15, attempts: 1 };
}

beforeEach(() => {
  rows.length = 0;
  setDefaultJevControlForTest(createMemoryJevControl().control);
});
afterAll(() => setDefaultJevControlForTest(null));

describe('VTID-04797 A8 finding dedupe', () => {
  test('what Jev sees: title, signal, file path, summary — capped', () => {
    expect(findingText(NEW)).toBe(`title: Missing tests for orb-live.ts\nsignal: missing_tests\nfile: ${FILE}\nsummary: No unit tests cover connectToLiveAPI`);
    expect(findingText({ ...NEW, summary: 'x'.repeat(9000) }).length).toBeLessThanOrEqual(4000);
  });

  test('off (default, typo): nothing loaded, asked or written', async () => {
    const call = jest.fn();
    for (const env of [JEV_ON, { ...JEV_ON, JEV_FINDING_DEDUPE_MODE: 'true' }]) {
      const d = deps(NEW, [C1]);
      expect(isFindingDedupeOn(env)).toBe(false);
      expect(await runFindingDedupeCheck({ fingerprint: 'fp', deps: d, env, sb, decideOptions: { call } })).toBeNull();
      expect(d.loadNew).not.toHaveBeenCalled();
    }
    expect(call).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  test('no other live finding on the file: nothing asked', async () => {
    const call = jest.fn();
    expect(await runFindingDedupeCheck({ fingerprint: 'fp', deps: deps(NEW, []), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runFindingDedupeCheck({ fingerprint: 'fp', deps: deps(null, [C1]), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(await runFindingDedupeCheck({ fingerprint: 'fp', deps: deps({ ...NEW, file_path: null }, [C1]), env: SHADOW, sb, decideOptions: { call } })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  test('shadow: compares with each candidate, records the closest one on the new finding', async () => {
    const call = jest.fn().mockResolvedValueOnce(dup(0.1)).mockResolvedValueOnce(dup(0.92));
    const d = deps(NEW, [C1, C2]);
    expect(await runFindingDedupeCheck({ fingerprint: 'fp-1', deps: d, env: SHADOW, sb, decideOptions: { call } })).toBe('s1');
    expect(d.loadCandidates).toHaveBeenCalledWith(FILE, 'new-1', MAX_CANDIDATES);
    expect(call).toHaveBeenCalledTimes(2);
    expect(rows[0]).toMatchObject({
      gate: 'finding_dedupe', decision: 'finding_duplicate', mode: 'shadow', plane: 'internal', tenant_id: null,
      subject_type: 'dev_autopilot_finding', subject_ref: 'new-1', jev_outcome: 'decided',
      jev_verdict: { duplicate: true, closest_id: 'old-2', probability: 0.92, candidates: 2, compared: 2 },
      system_action: 'inserted_as_new',
    });
  });

  test('no candidate close enough: duplicate false', async () => {
    const call = jest.fn().mockResolvedValue(dup(0.2));
    await runFindingDedupeCheck({ fingerprint: 'fp', deps: deps(NEW, [C1]), env: SHADOW, sb, decideOptions: { call } });
    expect(rows[0].jev_verdict).toMatchObject({ duplicate: false, closest_id: 'old-1' });
  });

  test('never more than MAX_CANDIDATES calls', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...C1, id: `c${i}` }));
    const call = jest.fn().mockResolvedValue(dup(0.1));
    const d = { loadNew: jest.fn(async () => NEW), loadCandidates: jest.fn(async () => many) };
    await runFindingDedupeCheck({ fingerprint: 'fp', deps: d, env: SHADOW, sb, decideOptions: { call } });
    expect(call).toHaveBeenCalledTimes(MAX_CANDIDATES);
  });

  test('Jev unavailable: a fallback row; a throwing loader: nothing; never throws', async () => {
    const failing = jest.fn().mockResolvedValue({ ok: false, reason: 'http_503', retryable: true, attempts: 2, latency_ms: 5 });
    await runFindingDedupeCheck({ fingerprint: 'fp', deps: deps(NEW, [C1]), env: SHADOW, sb, decideOptions: { call: failing } });
    expect(rows[0]).toMatchObject({ jev_outcome: 'fallback', cost_usd: 0 });
    const broken = { loadNew: jest.fn(async () => { throw new Error('db'); }), loadCandidates: jest.fn() };
    await expect(runFindingDedupeCheck({ fingerprint: 'fp', deps: broken as any, env: SHADOW, sb })).resolves.toBeNull();
  });
});

describe('VTID-04797 wiring and pins', () => {
  const root = path.resolve(__dirname, '../../..');
  const syn = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-synthesis.ts'), 'utf8');

  test('runs only after a new finding was inserted, never awaited', () => {
    const insert = syn.indexOf("source_type: 'dev_autopilot',\n        source_run_id: runId,");
    const gate = syn.indexOf('void runFindingDedupeCheck({ fingerprint, deps: findingDedupeDeps(supa) })');
    expect(insert).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(insert);
    expect(syn).toContain('if (inserted.ok) {\n      newCount++;');
    expect(syn).toContain('if (isFindingDedupeOn()) void runFindingDedupeCheck(');
  });

  test('candidates are live dev findings on the same file, never the new row', () => {
    expect(syn).toContain('status=in.(new,snoozed,activated)&spec_snapshot->>file_path=eq.${encodeURIComponent(filePath)}&id=neq.${excludeId}');
  });

  test('both gateways pin shadow, never enforce', () => {
    for (const f of ['AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-PROD-DEPLOY-GATEWAY.yml']) {
      const wf = fs.readFileSync(path.join(root, '.github/workflows', f), 'utf8');
      expect(wf).toContain('{name:"JEV_FINDING_DEDUPE_MODE", value:"shadow"}');
      expect(wf).not.toContain('{name:"JEV_FINDING_DEDUPE_MODE", value:"enforce"}');
    }
    const { GATEWAY_WORKFLOW_PINS } = require('../src/services/conversation/conversation-flag-pins.generated');
    expect(GATEWAY_WORKFLOW_PINS.JEV_FINDING_DEDUPE_MODE).toEqual({ staging: 'shadow', prod: 'shadow' });
  });
});
