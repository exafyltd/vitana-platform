/**
 * VTID-04475 — one self_healing_log row per incident.
 *
 * The Dev Autopilot bridge used to POST a new `VTID-DA-<exec8>` row for every
 * failed stage of every execution in a retry chain, on top of the incident's
 * own row when the execution came from a self-healing report. It now resolves
 * one incident key and updates that row when it exists.
 */
import { resolveIncidentLogKey, mergeIncidentLogUpdate, writeSelfHealingLogEntry } from '../src/services/dev-autopilot-bridge';

const s = { url: 'https://db.test', key: 'k' } as any;
const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });
}

const EXEC = { id: 'cccccccc-0000-0000-0000-000000000003', finding_id: 'f-1', parent_execution_id: 'bbbbbbbb-0000-0000-0000-000000000002', plan_version: 1, status: 'failed', auto_fix_depth: 2 } as any;

beforeEach(() => fetchMock.mockReset());

describe('resolveIncidentLogKey', () => {
  it('uses the incident VTID for an execution that came from a self-healing report', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('autopilot_recommendations') ? json(200, [{ activated_vtid: 'VTID-09999', spec_snapshot: { scanner: 'self-healing' } }]) : json(200, []));
    await expect(resolveIncidentLogKey(s, EXEC)).resolves.toEqual({ vtid: 'VTID-09999', mode: 'incident' });
  });

  it('keys a retry chain on its ROOT execution, walking parent links', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('autopilot_recommendations')) return json(200, [{ activated_vtid: 'VTID-01111', spec_snapshot: { scanner: 'lint-scanner' } }]);
      if (url.includes('id=eq.bbbbbbbb')) return json(200, [{ id: 'bbbbbbbb-0000-0000-0000-000000000002', parent_execution_id: 'aaaaaaaa-0000-0000-0000-000000000001' }]);
      if (url.includes('id=eq.aaaaaaaa')) return json(200, [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', parent_execution_id: null }]);
      return json(200, []);
    });
    await expect(resolveIncidentLogKey(s, EXEC)).resolves.toEqual({ vtid: 'VTID-DA-aaaaaaaa', mode: 'chain' });
  });

  it('stops on a parent-link cycle instead of looping', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('autopilot_recommendations')) return json(200, [{}]);
      if (url.includes('id=eq.bbbbbbbb')) return json(200, [{ id: 'bbbbbbbb-0000-0000-0000-000000000002', parent_execution_id: EXEC.id }]);
      return json(200, []);
    });
    const key = await resolveIncidentLogKey(s, EXEC);
    expect(key).toEqual({ vtid: 'VTID-DA-bbbbbbbb', mode: 'chain' });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('falls back to the old per-execution key when a lookup fails', async () => {
    fetchMock.mockImplementation(() => json(500, { error: 'boom' }));
    await expect(resolveIncidentLogKey(s, EXEC)).resolves.toEqual({ vtid: 'VTID-DA-cccccccc', mode: 'fallback' });
  });
});

describe('mergeIncidentLogUpdate', () => {
  it('keeps prior diagnosis, appends to stage_history, never lowers attempt_number', () => {
    const body = mergeIncidentLogUpdate(
      { id: 'r1', attempt_number: 3, outcome: 'pending', diagnosis: { root_cause: 'x', stage_history: [{ outcome: 'pending' }] } },
      { failure_class: 'dev_autopilot_max_retries_reached', confidence: 0.4, outcome: 'escalated', attempt_number: 2, endpoint: 'e',
        diagnosis: { summary: 'Escalated', execution_id: 'c', stage: 'ci' } },
    ) as any;
    expect(body.outcome).toBe('escalated');
    expect(body.attempt_number).toBe(3);
    expect(body.resolved_at).toEqual(expect.any(String));
    expect(body.diagnosis.root_cause).toBe('x');
    expect(body.diagnosis.stage_history).toHaveLength(2);
    expect(body.diagnosis.stage_history[1]).toMatchObject({ outcome: 'escalated', stage: 'ci', execution_id: 'c' });
  });

  it("keeps the incident's original failure class", () => {
    const first = mergeIncidentLogUpdate({ id: 'r1', failure_class: 'endpoint_down', diagnosis: {} },
      { failure_class: 'dev_autopilot_self_heal_in_progress', confidence: 0.9, outcome: 'pending', attempt_number: 1, endpoint: 'e', diagnosis: {} }) as any;
    expect(first.diagnosis.original_failure_class).toBe('endpoint_down');
    const second = mergeIncidentLogUpdate({ id: 'r1', failure_class: first.failure_class, diagnosis: first.diagnosis },
      { failure_class: 'dev_autopilot_max_retries_reached', confidence: 0.3, outcome: 'escalated', attempt_number: 2, endpoint: 'e', diagnosis: {} }) as any;
    expect(second.diagnosis.original_failure_class).toBe('endpoint_down');
  });

  it('leaves resolved_at null while the incident is still being retried', () => {
    const body = mergeIncidentLogUpdate({ id: 'r1' }, { failure_class: 'x', confidence: 0.9, outcome: 'pending', attempt_number: 1, endpoint: 'e', diagnosis: {} }) as any;
    expect(body.resolved_at).toBeNull();
  });

  it('bounds stage_history at 20 entries', () => {
    const hist = Array.from({ length: 25 }, (_, i) => ({ i }));
    const body = mergeIncidentLogUpdate({ id: 'r1', diagnosis: { stage_history: hist } }, { failure_class: 'x', confidence: 1, outcome: 'failed', attempt_number: 1, endpoint: 'e', diagnosis: {} }) as any;
    expect(body.diagnosis.stage_history).toHaveLength(20);
  });
});

describe('writeSelfHealingLogEntry', () => {
  const args = {
    execution_id: EXEC.id, exec: { ...EXEC, parent_execution_id: null }, endpoint: 'dev_autopilot.execution.ci',
    failure_class: 'dev_autopilot_low_confidence', confidence: 0.3, outcome: 'escalated' as const, attempt_number: 1,
    diagnosis: { summary: 'Escalated', execution_id: EXEC.id, stage: 'ci' },
  };

  it("PATCHes the incident's existing row instead of adding a second one", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('autopilot_recommendations')) return json(200, [{ activated_vtid: 'VTID-09999', spec_snapshot: { scanner: 'self-healing' } }]);
      if (url.includes('self_healing_log?vtid=')) return json(200, [{ id: 'row-7', attempt_number: 1, failure_class: 'endpoint_down', diagnosis: {} }]);
      return json(200, []);
    });
    await writeSelfHealingLogEntry(s, args);
    const writes = fetchMock.mock.calls.filter(([, init]) => init && init.method && init.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('https://db.test/rest/v1/self_healing_log?id=eq.row-7');
    expect(writes[0][1].method).toBe('PATCH');
  });

  it('inserts exactly one row keyed by the incident when none exists yet', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('autopilot_recommendations')) return json(200, [{ spec_snapshot: { scanner: 'lint' } }]);
      if (url.includes('self_healing_log?vtid=')) return json(200, []);
      return json(201, '');
    });
    await writeSelfHealingLogEntry(s, args);
    const writes = fetchMock.mock.calls.filter(([, init]) => init && init.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][1].body).vtid).toBe('VTID-DA-cccccccc');
  });

  it('never throws when the database is unreachable', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('down')));
    await expect(writeSelfHealingLogEntry(s, args)).resolves.toBeUndefined();
  });
});
