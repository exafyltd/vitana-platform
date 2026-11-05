/**
 * VTID-05387 (operating-workflow/pm-noop, supersedes pm-reassign-idempotent/reassign-noop):
 * the PM writes a lane file only when something changes. Two ticks over the same
 * observed lane produce one write and then none; the writer skips the PUT on W1
 * and W2 when the change is already in the file, and `writeFile` skips an
 * unchanged text. Before this fix every tick appended the same log line and bumped
 * `updated:` (8,118 commits on #4333).
 */
import {
  GithubRepoFileWriter,
  applyLaneChange,
  laneChangeIsNoop,
  type GithubWriteClient,
} from '../../src/services/project-manager/writers';
import { actOnDecisions, type ActDeps, type LaneFileChange } from '../../src/services/project-manager/act';
import type { LeaseManager } from '../../src/services/project-manager/lease';

const GRANT: LeaseManager = { acquire: async () => ({ acquired: true }) } as unknown as LeaseManager;
import type { ObservedLane, ObservedState, ReassignDecision } from '../../src/services/project-manager/types';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const P = 'exafyltd/vitana-platform';

const LANE = `---
lane: l1
state: in-review
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
area: platform
paths:
  - services/gateway/src/services/demo/**
updated: 2026-10-27T10:00Z
vtid: VTID-09001
---
# l1
## Log
### 2026-10-27T10:00Z · kiro-exafy-202610271000-aaaa · executing → in-review
ready for review
`;

const HANDOFF = `---
slug: demo
state: executing
vtids: [VTID-09000, VTID-09001]
---
# demo
`;

/** An in-memory GitHub: put() really changes the stored file, like the contents API. */
function memoryClient() {
  const files = new Map<string, string>();
  const puts: Array<{ branch: string; path: string; text: string }> = [];
  const pulls: string[] = [];
  const refs: Record<string, string> = { main: 'm'.repeat(40) };
  const key = (branch: string, path: string) => `${branch}:${path}`;
  const client: GithubWriteClient = {
    file: async (_r, path, ref) => {
      if (path.endsWith('handoff.md')) return { text: HANDOFF, sha: 'hs' };
      const t = files.get(key(ref, path)) ?? (path.endsWith('timings.json') ? undefined : LANE);
      return t === undefined ? null : { text: t, sha: `s${puts.length}` };
    },
    put: async (_r, path, branch, text) => {
      puts.push({ branch, path, text });
      files.set(key(branch, path), text);
    },
    pullHead: async () => ({ ref: 'kiro/demo/l1', sha: 'h'.repeat(40) }),
    refSha: async (_r, b) => refs[b] ?? null,
    createRef: async (_r, b, sha) => { refs[b] = sha; },
    findOpenPull: async (_r, head) => (pulls.includes(head) ? 'url' : null),
    createPull: async (_r, head) => { pulls.push(head); return 'url'; },
  };
  return { client, puts, pulls };
}

const REVIEW_CHANGE: LaneFileChange = {
  slug: 'demo',
  lane: 'l1',
  repo: P,
  next_actor: 'kiro',
  log: 'reassign review exafyltd→kiro (stale_review, Claude unavailable)',
};

describe('laneChangeIsNoop', () => {
  it('is false for a change the file does not have yet, true once it is applied', () => {
    expect(laneChangeIsNoop(LANE, { ...REVIEW_CHANGE, state: 'executing' })).toBe(false);
    const applied = applyLaneChange(LANE, REVIEW_CHANGE, '2026-10-28T12:00:00.000Z');
    expect(laneChangeIsNoop(applied, REVIEW_CHANGE)).toBe(true);
  });
  it('ignores updated: and the heading time, never the log body', () => {
    const applied = applyLaneChange(LANE, REVIEW_CHANGE, '2026-10-28T12:00:00.000Z');
    expect(laneChangeIsNoop(applied, { ...REVIEW_CHANGE, log: 'a different line' })).toBe(false);
  });
});

describe('GithubRepoFileWriter writes once, then nothing', () => {
  it('W2 (bookkeeping): the same change twice → one put, second call reports noop', async () => {
    const m = memoryClient();
    const w = new GithubRepoFileWriter(m.client, { now: () => NOW });
    await expect(w.write(REVIEW_CHANGE)).resolves.toBe('written');
    await expect(w.write(REVIEW_CHANGE)).resolves.toBe('noop');
    expect(m.puts).toHaveLength(1);
    expect(m.puts[0].branch).toBe('pm-agent/demo');
    expect(m.pulls).toEqual(['pm-agent/demo']);
  });
  it('W1 (lane PR branch): the same change twice → one put', async () => {
    const m = memoryClient();
    const w = new GithubRepoFileWriter(m.client, { now: () => NOW });
    const c: LaneFileChange = { ...REVIEW_CHANGE, state: 'verified', target: 'pr_branch', pr_url: `https://github.com/${P}/pull/1`, log: 'agent accept' };
    await expect(w.write(c)).resolves.toBe('written');
    await expect(w.write(c)).resolves.toBe('noop');
    expect(m.puts).toHaveLength(1);
    expect(m.puts[0].branch).toBe('kiro/demo/l1');
  });
  it('a noop creates no bookkeeping branch and no PR', async () => {
    const m = memoryClient();
    const w = new GithubRepoFileWriter(m.client, { now: () => NOW });
    const already = applyLaneChange(LANE, REVIEW_CHANGE, '2026-10-28T11:00:00.000Z');
    m.client.file = async (_r, path) => (path.endsWith('handoff.md') ? { text: HANDOFF, sha: 'hs' } : { text: already, sha: 'x' });
    await expect(w.write(REVIEW_CHANGE)).resolves.toBe('noop');
    expect(m.puts).toHaveLength(0);
    expect(m.pulls).toHaveLength(0);
  });
  it('writeFile skips an unchanged text', async () => {
    const m = memoryClient();
    const w = new GithubRepoFileWriter(m.client, { now: () => NOW });
    const path = 'docs/validation/VTID-09000/timings.json';
    await expect(w.writeFile(P, 'demo', path, '{"a":1}\n', 'pm: timings')).resolves.toBe('written');
    await expect(w.writeFile(P, 'demo', path, '{"a":1}\n', 'pm: timings')).resolves.toBe('noop');
    await expect(w.writeFile(P, 'demo', path, '{"a":2}\n', 'pm: timings')).resolves.toBe('written');
    expect(m.puts).toHaveLength(2);
  });
});

describe('two ticks over the same observed lane', () => {
  function lane(): ObservedLane {
    return {
      slug: 'demo', lane: 'l1', vtid: 'VTID-09001', state: 'in-review', seat: 'exafy', reviewer_seat: '',
      area: 'platform', paths: ['services/gateway/src/services/demo/**'], depends_on: [], pr: null, reviews: [],
      executing_log: [], state_since: new Date(NOW - 30 * 3600_000).toISOString(), last_branch_activity: null,
      claimed_at: null, seat_ran_automation_in_window: false, staging_verified: false, deploys: false,
      staging_verified_at: null, gate2_sent: false, repo: P,
    } as ObservedLane;
  }
  it('write once, then zero; the second act reports unchanged', async () => {
    process.env.PM_MODE = 'live';
    const m = memoryClient();
    const writer = new GithubRepoFileWriter(m.client, { now: () => NOW });
    const deps: ActDeps = {
      safeMerge: async () => { throw new Error('no merge expected'); },
      laneWriter: writer,
      gate2Poster: { post: async () => undefined },
      gate2Evidence: { resolve: async () => ({ verified_commit: 'v', production_commit: 'p', commits: [] }) },
      lease: GRANT,
    };
    const d: ReassignDecision = { kind: 'reassign', slug: 'demo', lane: 'l1', target: 'review', from_seat: '', to_actor: 'exafyltd', reason: 'stale_review', window_ms: 7200000, fallback: true };
    const state: ObservedState = { mode: 'live', lanes: [lane()], rotations: [] };
    const first = await actOnDecisions([d], state, deps);
    const second = await actOnDecisions([d], state, deps);
    expect(first.results[0].status).toBe('reassigned');
    expect(second.results[0].status).toBe('unchanged');
    expect(m.puts).toHaveLength(1);
  });
});
