/**
 * VTID-05736 (agentic-delivery-scope/dispatcher-pm): the retry schedule of lane `dispatcher` wired into the Project Manager.
 *
 *   decide : a parked lane with a retryable reason gets a `retry` decision when its backoff is due; never for the reasons
 *            that are never retried; the sixth attempt's end is recorded once as `blocked`
 *   act    : dry_run writes nothing; live unparks to `parked_from` through the pm-agent lane writer (only the PM keys of the
 *            lane file change) and records delivery.retry.scheduled; after the 6th attempt it records delivery.blocked
 *   loop   : the history the rule counts is the lane log the PM itself wrote (real `applyLaneChange` -> real `parseLaneLog`
 *            -> real `parkInfoOf` -> real `decide`), so park -> retry x6 -> blocked works across ticks
 */
import { actOnDecisions, type ActDeps, type LaneFileChange } from '../../src/services/project-manager/act';
import { decide, retryDecision } from '../../src/services/project-manager/decide';
import { summarizeDecision } from '../../src/services/project-manager/emit';
import { applyLaneChange, laneChangeIsNoop } from '../../src/services/project-manager/writers';
import { parseFrontMatter, parseLaneLog, parkInfoOf } from '../../src/services/project-manager/observe-live';
import { NoLeaseManager } from '../../src/services/project-manager/lease';
import type { LeaseManager, LeaseOutcome } from '../../src/services/project-manager/lease';
import type { CicdOasisEvent } from '../../src/types/cicd';
import type { ObservedLane, ObservedState, RetryDecision } from '../../src/services/project-manager/types';

const MIN = 60_000;
const T0 = Date.parse('2026-11-18T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function parked(over: Partial<ObservedLane> = {}): ObservedLane {
  return {
    slug: 'plan-x', lane: 'lane-a', vtid: 'VTID-05999', state: 'parked', seat: 'exafy', reviewer_seat: 'agent:vitana-lane-reviewer',
    area: null, paths: ['src/**'], depends_on: [], pr: null, reviews: [], executing_log: [], state_since: iso(T0),
    last_branch_activity: null, claimed_at: null, seat_ran_automation_in_window: true, staging_verified: false, deploys: false,
    staging_verified_at: null, gate2_sent: false, repo: 'exafyltd/vitana-platform',
    parked_from: 'in-review', next_actor: 'claude', executor: 'kiro', parked_at: iso(T0), park_reason: 'ci_failed_3_consecutive',
    retry_attempts: [], retry_blocked: false,
    ...over,
  };
}
const world = (lanes: ObservedLane[], mode: ObservedState['mode'] = 'live'): ObservedState => ({ mode, lanes, rotations: [] });

class FakeWriter {
  changes: LaneFileChange[] = [];
  write = async (c: LaneFileChange): Promise<'written' | 'noop'> => { this.changes.push(c); return 'written'; };
}
class Acquired implements LeaseManager {
  async acquire(holder: string): Promise<LeaseOutcome> { return { acquired: true, holder, expires_at: iso(T0 + 9 * MIN) }; }
}
function deps(writer: FakeWriter, events: CicdOasisEvent[], extra: Partial<ActDeps> = {}): ActDeps {
  return {
    safeMerge: async () => { throw new Error('a retry must never merge'); },
    laneWriter: writer,
    gate2Poster: { post: async () => { throw new Error('a retry must never post Gate 2'); } },
    gate2Evidence: { resolve: async () => { throw new Error('unused'); } },
    lease: new Acquired(),
    emitEvent: async (e) => { events.push(e); return { ok: true }; },
    ...extra,
  };
}

const prevMode = process.env.PM_MODE;
afterEach(() => { if (prevMode === undefined) delete process.env.PM_MODE; else process.env.PM_MODE = prevMode; });

describe('retryDecision (decide)', () => {
  it('a parked lane with a retryable reason is not retried before its backoff is due', () => {
    expect(retryDecision(parked(), T0 + 14 * MIN)).toBeNull();
  });

  it('is retried when due: unpark to parked_from, back to the executor, attempt 1 of 6 after 15 min', () => {
    const d = retryDecision(parked(), T0 + 15 * MIN) as RetryDecision;
    expect(d).toMatchObject({ kind: 'retry', outcome: 'unpark', slug: 'plan-x', lane: 'lane-a', attempt: 1, parked_from: 'in-review', next_actor: 'kiro', reason: 'ci_failed_3_consecutive', backoff_minutes: 15 });
    expect(d.at).toBe(iso(T0 + 15 * MIN));
  });

  it('hands the lane back to claude when claude is its executor, and to ready when parked_from is unknown', () => {
    const d = retryDecision(parked({ executor: 'claude', parked_from: null }), T0 + 15 * MIN) as RetryDecision;
    expect(d).toMatchObject({ next_actor: 'claude', parked_from: 'ready' });
  });

  it.each(['security_risk', 'data_loss_risk', 'production_write', 'protected_file_unreviewed', 'sparring_escalated', 'reviewer_flagged_risk', 'stale_claim', null])(
    'never retries a lane parked for %s',
    (reason) => {
      expect(retryDecision(parked({ park_reason: reason as string | null }), T0 + 10 * 24 * 60 * MIN)).toBeNull();
    },
  );

  it('does nothing for a lane that is not parked', () => {
    expect(retryDecision(parked({ state: 'ready' }), T0 + 60 * MIN)).toBeNull();
    expect(retryDecision(parked({ state: 'executing' }), T0 + 60 * MIN)).toBeNull();
  });

  it('the second attempt waits 30 min after the first', () => {
    const l = parked({ retry_attempts: [{ attempt: 1, at: iso(T0 + 15 * MIN) }] });
    expect(retryDecision(l, T0 + 44 * MIN)).toBeNull();
    expect(retryDecision(l, T0 + 45 * MIN)).toMatchObject({ outcome: 'unpark', attempt: 2, backoff_minutes: 30 });
  });

  it('after the 6th attempt the end is a single `blocked` decision, then nothing', () => {
    const attempts = [15, 45, 105, 225, 465, 945].map((m, i) => ({ attempt: i + 1, at: iso(T0 + m * MIN) }));
    const now = T0 + 946 * MIN;
    expect(retryDecision(parked({ retry_attempts: attempts }), now)).toMatchObject({ kind: 'retry', outcome: 'blocked', attempt: 6, reason: 'ci_failed_3_consecutive' });
    expect(retryDecision(parked({ retry_attempts: attempts, retry_blocked: true }), now)).toBeNull();
  });

  it('decide() carries it: dry_run decides, off decides nothing, a parked lane is not also parked again', () => {
    const l = parked();
    const now = T0 + 20 * MIN;
    expect(decide(world([l], 'dry_run'), now).filter((d) => d.kind === 'retry')).toHaveLength(1);
    expect(decide(world([l], 'off'), now)).toEqual([]);
  });

  it('summarizes both outcomes in one line', () => {
    const u = retryDecision(parked(), T0 + 15 * MIN) as RetryDecision;
    expect(summarizeDecision(u)).toContain('attempt 1 of 6');
    expect(summarizeDecision({ ...u, outcome: 'blocked', attempt: 6 })).toContain('blocked after 6 attempts');
  });
});

describe('act: dry_run writes nothing, live unparks through the pm-agent writer', () => {
  it.each(['dry_run', 'off'] as const)('%s: no lane write, no event', async (mode) => {
    process.env.PM_MODE = mode;
    const w = new FakeWriter(); const ev: CicdOasisEvent[] = [];
    const d = retryDecision(parked(), T0 + 20 * MIN) as RetryDecision;
    const res = await actOnDecisions([d], world([parked()]), deps(w, ev));
    expect(res).toMatchObject({ acted: false, skipped_reason: 'not_live', results: [] });
    expect(w.changes).toHaveLength(0);
    expect(ev).toHaveLength(0);
  });

  it('live: unparks to parked_from, sets next_actor, logs the attempt and records delivery.retry.scheduled', async () => {
    process.env.PM_MODE = 'live';
    const w = new FakeWriter(); const ev: CicdOasisEvent[] = [];
    const d = retryDecision(parked(), T0 + 20 * MIN) as RetryDecision;
    const res = await actOnDecisions([d], world([parked()]), deps(w, ev));
    expect(res.results[0]).toMatchObject({ status: 'retried' });
    expect(w.changes).toEqual([
      { slug: 'plan-x', lane: 'lane-a', repo: 'exafyltd/vitana-platform', state: 'in-review', next_actor: 'kiro',
        log: 'retry attempt 1 of 6 (ci_failed_3_consecutive; backoff 15 min); unparked to in-review' },
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'delivery.retry.scheduled', source: 'project-manager', status: 'info', payload: { lane: 'plan-x/lane-a', attempt: 1, reason: 'ci_failed_3_consecutive', unparked_to: 'in-review' } });
  });

  it('live: the 6th attempt spent -> the lane stays parked with next_actor owner and delivery.blocked is recorded', async () => {
    process.env.PM_MODE = 'live';
    const attempts = [15, 45, 105, 225, 465, 945].map((m, i) => ({ attempt: i + 1, at: iso(T0 + m * MIN) }));
    const l = parked({ retry_attempts: attempts });
    const w = new FakeWriter(); const ev: CicdOasisEvent[] = [];
    const d = retryDecision(l, T0 + 946 * MIN) as RetryDecision;
    const res = await actOnDecisions([d], world([l]), deps(w, ev));
    expect(res.results[0]).toMatchObject({ status: 'retry_blocked' });
    expect(w.changes).toHaveLength(1);
    expect(w.changes[0]).toMatchObject({ next_actor: 'owner' });
    expect(w.changes[0].state).toBeUndefined();
    expect(w.changes[0].log).toMatch(/^retry blocked after 6 attempts in 24 h/);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'delivery.blocked', status: 'warning', payload: { lane: 'plan-x/lane-a', attempts: 6, next_actor: 'owner' } });
  });

  it('a failing event write never undoes the unpark', async () => {
    process.env.PM_MODE = 'live';
    const w = new FakeWriter();
    const d = retryDecision(parked(), T0 + 20 * MIN) as RetryDecision;
    const res = await actOnDecisions([d], world([parked()]), deps(w, [], { emitEvent: async () => { throw new Error('oasis down'); } }));
    expect(res.results[0]).toMatchObject({ status: 'retried', detail: 'attempt 1, event_failed' });
    expect(w.changes).toHaveLength(1);
  });

  it('without an event writer the lane file still changes and the result says so', async () => {
    process.env.PM_MODE = 'live';
    const w = new FakeWriter();
    const d = retryDecision(parked(), T0 + 20 * MIN) as RetryDecision;
    const res = await actOnDecisions([d], world([parked()]), { ...deps(w, []), emitEvent: undefined });
    expect(res.results[0]).toMatchObject({ status: 'retried', detail: 'attempt 1, no_event_writer' });
  });

  it('the lease still gates it: without the lease nothing is written', async () => {
    process.env.PM_MODE = 'live';
    const w = new FakeWriter(); const ev: CicdOasisEvent[] = [];
    const d = retryDecision(parked(), T0 + 20 * MIN) as RetryDecision;
    const noLease: LeaseManager = { acquire: async (h) => ({ acquired: false, holder: h, reason: 'held_by_other' } as LeaseOutcome) };
    const res = await actOnDecisions([d], world([parked()]), deps(w, ev, { lease: noLease }));
    expect(res.skipped_reason).toBe('no_lease');
    expect(w.changes).toHaveLength(0);
  });
  void NoLeaseManager;
});

// ---- the whole loop over a real lane file: park -> retry -> ... -> blocked ------------------------------------------------
const LANE_FILE = `---
lane: lane-a
state: in-review
next_actor: kiro
seat: exafy
executor: kiro
reviewer_seat: agent:vitana-lane-reviewer
claimed_by: kiro-exafy-202611180900-abcd
paths:
  - src/**
updated: 2026-11-18T09:00Z
vtid: VTID-05999
---
# lane-a

## Log
### 2026-11-18T09:00Z · kiro-exafy-202611180900-abcd · created
built
`;

/** Re-observe a lane file the way the live observer does. */
function observeFile(text: string): ObservedLane {
  const fm = parseFrontMatter(text) as Record<string, string | string[]>;
  const log = parseLaneLog(text);
  return parked({
    state: String(fm.state) as ObservedLane['state'],
    state_since: new Date(Date.parse(String(fm.updated))).toISOString(),
    ...parkInfoOf(log, fm, (ts) => new Date(Date.parse(ts)).toISOString()),
  });
}

describe('the loop over a real lane file (applyLaneChange -> parseLaneLog -> parkInfoOf -> decide -> act)', () => {
  it('parks, retries on the 15/30/60/120/240/480 min schedule, then blocks and stays quiet', async () => {
    process.env.PM_MODE = 'live';
    let text = LANE_FILE;
    const t = (min: number) => iso(T0 + min * MIN);
    // the PM parks the lane (the log line the observer reads back is `park (<reason>)`)
    text = applyLaneChange(text, { slug: 'plan-x', lane: 'lane-a', state: 'parked', next_actor: 'claude', release_claim: true, log: 'park (ci_failed_3_consecutive); claim released' }, t(0));
    let l = observeFile(text);
    expect(l).toMatchObject({ state: 'parked', parked_from: 'in-review', park_reason: 'ci_failed_3_consecutive', next_actor: 'claude', retry_attempts: [], retry_blocked: false });
    expect(Date.parse(l.parked_at as string)).toBe(Date.parse('2026-11-18T10:00Z'));

    const ev: CicdOasisEvent[] = [];
    const writer = {
      write: async (c: LaneFileChange): Promise<'written' | 'noop'> => {
        if (laneChangeIsNoop(text, c)) return 'noop';
        text = applyLaneChange(text, c, c.log.includes('blocked') ? t(clockMin) : t(clockMin));
        return 'written';
      },
    };
    let clockMin = 0;
    const dueMinutes = [15, 45, 105, 225, 465, 945];
    for (let i = 0; i < 6; i++) {
      clockMin = dueMinutes[i];
      const now = T0 + clockMin * MIN;
      l = observeFile(text);
      expect(l.state).toBe('parked');
      expect(retryDecision(l, now - 1 * MIN)).toBeNull(); // not before it is due
      const decisions = decide(world([l]), now).filter((d) => d.kind === 'retry') as RetryDecision[];
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ outcome: 'unpark', attempt: i + 1, backoff_minutes: [15, 30, 60, 120, 240, 480][i] });
      const res = await actOnDecisions(decisions, world([l]), { ...deps(new FakeWriter(), ev), laneWriter: writer });
      expect(res.results[0].status).toBe('retried');
      // the lane is back in review and next_actor is the executor; the claim stays released
      const after = observeFile(text);
      expect(after).toMatchObject({ state: 'in-review', next_actor: 'kiro' });
      expect(decide(world([after]), now).filter((d) => d.kind === 'retry')).toHaveLength(0); // idempotent: no second retry for the same park
      // CI fails three times again: the PM parks it again, one minute later
      clockMin += 1;
      text = applyLaneChange(text, { slug: 'plan-x', lane: 'lane-a', state: 'parked', next_actor: 'claude', log: 'park (ci_failed_3_consecutive)' }, t(clockMin));
    }
    // the 7th time: blocked, recorded once
    clockMin = 947;
    l = observeFile(text);
    expect(l.retry_attempts).toHaveLength(6);
    const blocked = decide(world([l]), T0 + clockMin * MIN).filter((d) => d.kind === 'retry') as RetryDecision[];
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ outcome: 'blocked', attempt: 6 });
    const res = await actOnDecisions(blocked, world([l]), { ...deps(new FakeWriter(), ev), laneWriter: writer });
    expect(res.results[0].status).toBe('retry_blocked');
    const done = observeFile(text);
    expect(done).toMatchObject({ state: 'parked', next_actor: 'owner', retry_blocked: true });
    expect(decide(world([done]), T0 + 2000 * MIN).filter((d) => d.kind === 'retry')).toHaveLength(0); // quiet from now on
    expect(ev.map((e) => e.type)).toEqual([...Array(6).fill('delivery.retry.scheduled'), 'delivery.blocked']);
  });

  it('only the PM keys of the lane file change on a retry (state, next_actor, updated) and the log gets one entry', () => {
    const parkedText = applyLaneChange(LANE_FILE, { slug: 's', lane: 'lane-a', state: 'parked', next_actor: 'claude', log: 'park (infra_failure)' }, iso(T0));
    const retried = applyLaneChange(parkedText, { slug: 's', lane: 'lane-a', state: 'in-review', next_actor: 'kiro', log: 'retry attempt 1 of 6 (infra_failure; backoff 15 min); unparked to in-review' }, iso(T0 + 15 * MIN));
    const before = parseFrontMatter(parkedText) as Record<string, string | string[]>;
    const after = parseFrontMatter(retried) as Record<string, string | string[]>;
    const changed = Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
    expect(changed).toEqual(['next_actor', 'state', 'updated']);
    expect(parseLaneLog(retried).entries.length).toBe(parseLaneLog(parkedText).entries.length + 1);
  });
});
