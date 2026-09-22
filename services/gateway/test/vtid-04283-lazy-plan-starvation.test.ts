/**
 * VTID-04283: lazyPlanTick starved forever once a backlog of already-planned,
 * still-`status=new` findings outnumbered the tick's own candidate window.
 *
 * Reported live: "why does it still show 30 new findings since so many
 * hours. not one single of the new findings has started to be processed."
 * Confirmed against the live table (2026-09-22): 4 genuinely-unplanned
 * dev_autopilot findings (dead_code/stale_flag/missing_tests/todo, impact
 * scores 3-6) sat with zero dev_autopilot_plan_versions rows and zero
 * self_healing_log failure rows — lazyPlanTick had never even attempted
 * them, despite running every 30s for ~21 hours.
 *
 * Root cause: lazyPlanTick fetched only `LAZY_PLAN_BATCH_SIZE * 4` (12)
 * candidates ordered by impact_score desc, then checked "does a plan exist
 * yet?" ONE ROW AT A TIME inside the loop, `continue`-ing past each
 * already-planned row. A permanent backlog of 25+ `operator_onramp`
 * findings (impact_score=5, planned since 2026-09-13, stuck at status=new
 * pending human review — a separate, legitimate situation) filled every
 * slot of that 12-row window on every single tick, so the loop never
 * reached a lower-impact, genuinely-unplanned candidate — `generated`
 * stayed 0 forever, no matter how many ticks ran.
 *
 * Fix: fetch a much wider candidate window (200), batch-check which of
 * them already have a plan in one (chunked) query up front instead of one
 * query per candidate, and only loop over the ones that come back
 * genuinely unplanned. Already-planned candidates can no longer occupy a
 * loop iteration at all, so the count of them ahead of a real candidate no
 * longer matters.
 */

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';

const generatePlanVersionMock = jest.fn().mockResolvedValue({ ok: true });

jest.mock('../src/services/dev-autopilot-planning', () => ({
  extractFilePaths: jest.fn(() => []),
  generatePlanVersion: (...args: unknown[]) => generatePlanVersionMock(...args),
}));

import { lazyPlanTick } from '../src/services/dev-autopilot-execute';

type Handler = (url: string, opts: any) => any | undefined;

function jsonRes(status: number, body: unknown = []) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function routeFetch(handler: Handler) {
  (global.fetch as jest.Mock).mockImplementation((url: any, opts: any = {}) => {
    const result = handler(String(url), opts || {});
    return Promise.resolve(result !== undefined ? result : jsonRes(200, []));
  });
}

function findingRow(id: string, impact: number) {
  return { id, impact_score: impact };
}

describe('lazyPlanTick — starvation fix (VTID-04283)', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    generatePlanVersionMock.mockClear();
    global.fetch = fetchMock as unknown as typeof fetch;
    routeFetch(() => undefined);
  });

  const CONFIG_ROW = {
    kill_switch: false,
    daily_budget: 100,
    concurrency_cap: 5,
    cooldown_minutes: 5,
    max_auto_fix_depth: 3,
    allow_scope: [],
    deny_scope: [],
  };

  it('reaches a genuinely-unplanned low-impact finding past 25 already-planned high-impact ones (the live starvation shape)', async () => {
    // 25 high-impact candidates that already have a plan version each
    // (the operator_onramp backlog shape), plus one real, unplanned,
    // lower-impact candidate at the tail — impact_score.desc puts the
    // planned ones first, exactly as observed live.
    const plannedIds = Array.from({ length: 25 }, (_, i) => `planned-${i}`);
    const unplannedId = 'dead-code-finding';
    const candidateIds = [...plannedIds, unplannedId];

    const planCheckUrls: string[] = [];
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_worker_queue')) return jsonRes(200, []);
      if (url.includes('/dev_autopilot_config')) return jsonRes(200, [CONFIG_ROW]);
      if (url.includes('/self_healing_log')) return jsonRes(200, []);
      if (url.includes('/dev_autopilot_plan_versions')) {
        planCheckUrls.push(url);
        // Every planned-* id in this chunk's `in.(...)` filter has a plan.
        const already = plannedIds.filter((id) => url.includes(id));
        return jsonRes(200, already.map((finding_id) => ({ finding_id })));
      }
      if (url.includes('/autopilot_recommendations') && method === 'GET') {
        return jsonRes(200, candidateIds.map((id, i) => findingRow(id, 26 - i)));
      }
      return undefined;
    });

    await lazyPlanTick();

    // The old per-row-check behaviour would never have reached the tail —
    // the fix means it does, and only it.
    expect(generatePlanVersionMock).toHaveBeenCalledTimes(1);
    expect(generatePlanVersionMock).toHaveBeenCalledWith(unplannedId);
    expect(planCheckUrls.length).toBeGreaterThan(0);
  });

  it('fetches a wide candidate window (well beyond the old 12-row limit)', async () => {
    let candidatesUrl = '';
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_worker_queue')) return jsonRes(200, []);
      if (url.includes('/dev_autopilot_config')) return jsonRes(200, [CONFIG_ROW]);
      if (url.includes('/self_healing_log')) return jsonRes(200, []);
      if (url.includes('/dev_autopilot_plan_versions')) return jsonRes(200, []);
      if (url.includes('/autopilot_recommendations') && method === 'GET') {
        candidatesUrl = url;
        return jsonRes(200, []);
      }
      return undefined;
    });

    await lazyPlanTick();

    expect(candidatesUrl).toMatch(/limit=(\d+)/);
    const limit = Number(candidatesUrl.match(/limit=(\d+)/)![1]);
    expect(limit).toBeGreaterThanOrEqual(100);
  });

  it('chunks the batch plan-existence check so the URL never carries an unbounded id list', async () => {
    // Zero-padded so no id is a substring of another (e.g. "cand-1" would
    // otherwise also match "cand-10".."cand-19"), which would corrupt the
    // per-chunk id counting below.
    const candidateIds = Array.from({ length: 130 }, (_, i) => `cand-${String(i).padStart(3, '0')}`);
    const planCheckCalls: string[] = [];
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_worker_queue')) return jsonRes(200, []);
      if (url.includes('/dev_autopilot_config')) return jsonRes(200, [CONFIG_ROW]);
      if (url.includes('/self_healing_log')) return jsonRes(200, []);
      if (url.includes('/dev_autopilot_plan_versions')) {
        planCheckCalls.push(url);
        // Every candidate already has a plan, so nothing should be planned.
        const idsInUrl = candidateIds.filter((id) => url.includes(id));
        return jsonRes(200, idsInUrl.map((finding_id) => ({ finding_id })));
      }
      if (url.includes('/autopilot_recommendations') && method === 'GET') {
        return jsonRes(200, candidateIds.map((id, i) => findingRow(id, 200 - i)));
      }
      return undefined;
    });

    await lazyPlanTick();

    // 130 candidates over a <=60-per-request chunk size means >=3 requests.
    expect(planCheckCalls.length).toBeGreaterThanOrEqual(3);
    // No single chunked request lists more than 60 candidate ids.
    for (const url of planCheckCalls) {
      const idCount = candidateIds.filter((id) => url.includes(id)).length;
      expect(idCount).toBeLessThanOrEqual(60);
    }
    expect(generatePlanVersionMock).not.toHaveBeenCalled();
  });

  it('fails open on a broken plan-existence chunk: that chunk\'s candidates are still offered to the planner rather than silently dropped', async () => {
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_worker_queue')) return jsonRes(200, []);
      if (url.includes('/dev_autopilot_config')) return jsonRes(200, [CONFIG_ROW]);
      if (url.includes('/self_healing_log')) return jsonRes(200, []);
      if (url.includes('/dev_autopilot_plan_versions')) return jsonRes(500, { message: 'db unavailable' });
      if (url.includes('/autopilot_recommendations') && method === 'GET') {
        return jsonRes(200, [findingRow('only-candidate', 5)]);
      }
      return undefined;
    });

    await lazyPlanTick();

    // Fail-open per chunk: a broken plan-existence read must not turn into
    // a stalled tick — the candidate still gets a chance at generatePlanVersion.
    expect(generatePlanVersionMock).toHaveBeenCalledWith('only-candidate');
  });

  it('still respects the per-tick batch size cap once genuinely-unplanned candidates are found', async () => {
    const unplannedIds = ['u1', 'u2', 'u3', 'u4', 'u5'];
    routeFetch((url, opts) => {
      const method = opts.method || 'GET';
      if (url.includes('/dev_autopilot_worker_queue')) return jsonRes(200, []);
      if (url.includes('/dev_autopilot_config')) return jsonRes(200, [CONFIG_ROW]);
      if (url.includes('/self_healing_log')) return jsonRes(200, []);
      if (url.includes('/dev_autopilot_plan_versions')) return jsonRes(200, []); // none planned
      if (url.includes('/autopilot_recommendations') && method === 'GET') {
        return jsonRes(200, unplannedIds.map((id, i) => findingRow(id, 10 - i)));
      }
      return undefined;
    });

    await lazyPlanTick();

    // LAZY_PLAN_BATCH_SIZE is 3 — even with 5 eligible unplanned candidates,
    // only the top 3 by impact_score get planned this tick.
    expect(generatePlanVersionMock).toHaveBeenCalledTimes(3);
    expect(generatePlanVersionMock).toHaveBeenNthCalledWith(1, 'u1');
    expect(generatePlanVersionMock).toHaveBeenNthCalledWith(2, 'u2');
    expect(generatePlanVersionMock).toHaveBeenNthCalledWith(3, 'u3');
  });
});
