/**
 * VTID-05414 (pm-reassign-idempotent-r2/reassign-noop-r2) — a PM tick that
 * would change nothing commits nothing. The observer reads lanes from main, so
 * while the bookkeeping PR is open the decider repeats the same reassignment
 * every tick; the writer reads the branch it writes and returns 'noop'.
 * In-memory GitHub fake; nothing leaves the process.
 */
import { actOnDecisions, type ActDeps, type LaneFileChange } from '../../src/services/project-manager/act';
import { reassignDecision } from '../../src/services/project-manager/decide';
import type { LeaseManager, LeaseOutcome } from '../../src/services/project-manager/lease';
import { GithubRepoFileWriter, laneChangeIsNoop, type GithubWriteClient } from '../../src/services/project-manager/writers';
import type { ObservedClaude, ObservedLane, ObservedState } from '../../src/services/project-manager/types';

const P = 'exafyltd/vitana-platform';
const NOW = Date.parse('2026-10-28T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const ISO = (ms: number) => new Date(ms).toISOString();
const UNAVAILABLE: ObservedClaude = { flag: false, oldest_assigned_at: null, last_action_at: null };
const PATH = '.kiro/specs/demo/lanes/l1.md';

const LANE = `---
lane: l1
state: ready
next_actor: kiro
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
updated: 2026-10-28T10:00Z
vtid: VTID-09001
---
# l1
## Log
### 2026-10-28T10:00Z · kiro-exafy-202610281000-aaaa · ready
Created.
`;
const HANDOFF = `---
slug: demo
state: approved
vtids: [VTID-09000]
---
`;

/** Branch-aware in-memory GitHub: files per ref, counts every write call. */
function fakeGithub() {
  const files: Record<string, Record<string, string>> = { main: { [PATH]: LANE, '.kiro/specs/demo/handoff.md': HANDOFF } };
  const calls = { put: 0, createRef: 0, createPull: 0 };
  const pulls: string[] = [];
  const client: GithubWriteClient = {
    file: async (_r, path, ref) => (files[ref]?.[path] != null ? { text: files[ref][path], sha: `${ref}:${path}` } : null),
    put: async (_r, path, branch, text) => { calls.put++; (files[branch] ??= {})[path] = text; },
    pullHead: async () => ({ ref: 'kiro/demo/l1', sha: 'h'.repeat(40) }),
    refSha: async (_r, b) => (files[b] ? 's'.repeat(40) : null),
    createRef: async (_r, b) => { calls.createRef++; files[b] = { ...files.main }; },
    findOpenPull: async (_r, head) => (pulls.includes(head) ? 'url' : null),
    createPull: async (_r, head) => { calls.createPull++; pulls.push(head); return 'url'; },
  };
  return { client, files, calls };
}

class Lease implements LeaseManager {
  async acquire(holder: string): Promise<LeaseOutcome> {
    return { acquired: true, holder, expires_at: ISO(NOW + HOUR) };
  }
}

function lane(): ObservedLane {
  return {
    slug: 'demo', lane: 'l1', vtid: 'VTID-09001', state: 'ready', seat: 'exafy', reviewer_seat: 'agent:vitana-lane-reviewer',
    area: 'platform', paths: [], depends_on: [], pr: null, reviews: [], executing_log: [],
    state_since: ISO(NOW - 30 * HOUR), last_branch_activity: null, claimed_at: null, seat_ran_automation_in_window: false,
    staging_verified: false, deploys: false, staging_verified_at: null, gate2_sent: false, repo: P,
  } as ObservedLane;
}

const prevMode = process.env.PM_MODE;
afterEach(() => {
  if (prevMode === undefined) delete process.env.PM_MODE;
  else process.env.PM_MODE = prevMode;
});

describe('VTID-05414 two ticks over the same observed lane: one write, then none', () => {
  it('tick 1 writes, tick 2 (later now) is a no-op: status unchanged, no put, no ref, no PR', async () => {
    process.env.PM_MODE = 'live';
    const gh = fakeGithub();
    let now = NOW;
    const writer = new GithubRepoFileWriter(gh.client, { now: () => now });
    const deps = (): ActDeps => ({
      safeMerge: async () => { throw new Error('no merge expected'); },
      laneWriter: writer,
      gate2Poster: { post: async () => undefined },
      gate2Evidence: { resolve: async () => ({ verified_commit: 'v', production_commit: 'p', commits: [] }) },
      lease: new Lease(),
    });
    const l = lane();
    const state: ObservedState = { mode: 'live', lanes: [l], rotations: [{ area: 'platform', seats: ['exafy'] }], claude: UNAVAILABLE };

    const d1 = reassignDecision(l, state, now);
    expect(d1).toMatchObject({ kind: 'reassign', to_actor: 'exafyltd', reason: 'stale_ready' });
    const r1 = await actOnDecisions([d1!], state, deps());
    expect(r1.results.map((r) => r.status)).toEqual(['reassigned']);
    expect(gh.calls).toEqual({ put: 1, createRef: 1, createPull: 1 });
    expect(gh.files['pm-agent/demo'][PATH]).toMatch(/^seat: exafyltd$/m);

    now = NOW + 4 * MIN; // main is unchanged, so the decider repeats itself
    const d2 = reassignDecision(l, state, now);
    expect(d2).toEqual({ ...d1 });
    const r2 = await actOnDecisions([d2!], state, deps());
    expect(r2.results.map((r) => r.status)).toEqual(['unchanged']);
    expect(gh.calls).toEqual({ put: 1, createRef: 1, createPull: 1 });
  });
});

describe('VTID-05414 GithubRepoFileWriter: the same change twice → one put', () => {
  const change: LaneFileChange = { slug: 'demo', lane: 'l1', seat: 'exafyltd', next_actor: 'exafyltd', log: 'reassign lane exafy→exafyltd (stale_ready, Claude unavailable)' };

  it('W2 (bookkeeping branch)', async () => {
    const gh = fakeGithub();
    let now = NOW;
    const w = new GithubRepoFileWriter(gh.client, { now: () => now });
    expect(await w.write({ ...change })).toBe('written');
    now += 4 * MIN;
    expect(await w.write({ ...change })).toBe('noop');
    expect(gh.calls.put).toBe(1);
  });

  it('W2 no-op on a fresh branch creates no ref and no PR', async () => {
    const gh = fakeGithub();
    gh.files.main[PATH] = gh.files.main[PATH]
      .replace('seat: exafy\n', 'seat: exafyltd\n')
      .concat(`### 2026-10-28T11:00Z · pm-agent · update\n${change.log}\n`);
    const w = new GithubRepoFileWriter(gh.client, { now: () => NOW });
    expect(await w.write({ ...change })).toBe('noop');
    expect(gh.calls).toEqual({ put: 0, createRef: 0, createPull: 0 });
  });

  it('W1 (lane PR branch)', async () => {
    const gh = fakeGithub();
    gh.files['kiro/demo/l1'] = { [PATH]: LANE };
    let now = NOW;
    const w = new GithubRepoFileWriter(gh.client, { now: () => now });
    const w1: LaneFileChange = { slug: 'demo', lane: 'l1', state: 'verified', target: 'pr_branch', pr_url: `https://github.com/${P}/pull/4242`, log: 'agent accept on head' };
    expect(await w.write({ ...w1 })).toBe('written');
    now += 4 * MIN;
    expect(await w.write({ ...w1 })).toBe('noop');
    expect(gh.calls.put).toBe(1);
  });
});

describe('VTID-05414 laneChangeIsNoop compares keys and the newest log body only', () => {
  const done = `${LANE.replace('seat: exafy\n', 'seat: exafyltd\n')}### 2026-10-28T11:00Z · pm-agent · update\nreassign x\n`;
  it('same keys + same newest log body → true, whatever updated: says', () => {
    expect(laneChangeIsNoop(done, { slug: 'demo', lane: 'l1', seat: 'exafyltd', next_actor: 'exafyltd', log: 'reassign x' })).toBe(true);
  });
  it('a different log body → false', () => {
    expect(laneChangeIsNoop(done, { slug: 'demo', lane: 'l1', seat: 'exafyltd', next_actor: 'exafyltd', log: 'reassign y' })).toBe(false);
  });
  it('a different key → false', () => {
    expect(laneChangeIsNoop(done, { slug: 'demo', lane: 'l1', seat: 'jtadic', next_actor: 'exafyltd', log: 'reassign x' })).toBe(false);
    expect(laneChangeIsNoop(done, { slug: 'demo', lane: 'l1', state: 'parked', log: 'reassign x' })).toBe(false);
  });
});
