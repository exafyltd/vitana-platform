/**
 * VTID-05274 — the live observer and the PM's GitHub writer (plan
 * kiro-autonomy-fallback §4.1, §4.5, §4.7, §5 C6). Read-only GitHub/Supabase
 * fakes; nothing leaves the process.
 */
import {
  GithubObserver,
  GithubRestReader,
  parseLaneLog,
  parseTrailers,
  reviewOnlySince,
  type GhCommit,
  type GhPull,
  type GithubReader,
  type PmDataReader,
} from '../../src/services/project-manager/observe-live';
import {
  GithubRepoFileWriter,
  applyLaneChange,
  type GithubWriteClient,
} from '../../src/services/project-manager/writers';
import { claudeAvailability } from '../../src/services/project-manager/decide';
import type { CheckRun } from '../../src/services/project-manager/types';

const P = 'exafyltd/vitana-platform';
const NOW = Date.parse('2026-10-20T20:00:00Z');
const HEAD = 'h'.repeat(40);
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);

const LANE = `---
lane: pm-fallback
state: in-review
next_actor: kiro
depends_on: [scope-check]
executor: kiro
seat: exafy
area: platform
reviewer_seat: exafyltd
paths:
  - services/gateway/src/services/project-manager/**
updated: 2026-10-20T19:30Z
vtid: VTID-05274
---
# pm-fallback
## Log
### 2026-10-20T19:20Z · kiro-exafy-202610201807-2a87 · executing → in-review
Decisions taken: kept pmMode() default; no webhook receiver
### 2026-10-20T19:40Z · agent-vitana-lane-reviewer-202610201940-abcd · review
review: accept
head: ${C2}
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
`;

const SCOPE = `---
lane: scope-check
state: done
next_actor: claude
executor: claude
seat: exafy
reviewer_seat: exafyltd
paths: [scripts/collab/queue.mjs]
updated: 2026-10-20T14:00Z
vtid: VTID-05276
---
`;

const HANDOFF = `---
slug: kiro-autonomy-fallback
state: approved
next_actor: kiro
updated: 2026-10-20T17:49Z
vtids: [VTID-05271, VTID-05274]
---
`;

const AREAS = `seats:
  exafy: { account: x }
areas:
  platform:
    seat: exafy
    priority: 10
  messenger:
    seat: exafyltd
`;

function reader(o: Partial<GithubReader> = {}): GithubReader {
  const files: Record<string, string> = {
    '.kiro/specs/kiro-autonomy-fallback/handoff.md': HANDOFF,
    '.kiro/specs/kiro-autonomy-fallback/lanes/pm-fallback.md': LANE,
    '.kiro/specs/kiro-autonomy-fallback/lanes/scope-check.md': SCOPE,
    'docs/programs/areas.yaml': AREAS,
  };
  const pulls: GhPull[] = [
    { number: 4240, html_url: `https://github.com/${P}/pull/4240`, title: 'VTID-05274: pm fallback', head_ref: 'kiro/kiro-autonomy-fallback/pm-fallback', head_sha: HEAD, created_at: '2026-10-20T19:00:00Z' },
  ];
  const commits: GhCommit[] = [
    { sha: C1, message: 'feat\n\nCollab-Session: kiro-exafy-202610201807-2a87\nCollab-Lane: kiro-autonomy-fallback/pm-fallback', date: '2026-10-20T19:10:00Z' },
    { sha: C2, message: 'fix\n\nCollab-Session: kiro-exafy-202610201807-2a87\nCollab-Lane: kiro-autonomy-fallback/pm-fallback', date: '2026-10-20T19:30:00Z' },
    { sha: C3, message: 'review\n\nCollab-Session: agent-vitana-lane-reviewer-202610201940-abcd\nCollab-Review: kiro-autonomy-fallback/pm-fallback\nCollab-Verdict: accept\nCollab-Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)\nCollab-Reviewed-Head: ' + C2, date: '2026-10-20T19:40:00Z' },
    { sha: HEAD, message: 'pm\n\nCollab-Session: pm-agent\nCollab-Lane: kiro-autonomy-fallback/pm-fallback', date: '2026-10-20T19:45:00Z' },
  ];
  const checks: CheckRun[] = [
    { name: 'Lane scope', conclusion: 'success', head_sha: HEAD },
    { name: 'Collab handoff', conclusion: 'success', head_sha: HEAD },
  ];
  return {
    tree: async (repo) => (repo === P ? Object.keys(files).map((path) => ({ path, sha: `sha:${path}` })) : []),
    blob: async (_repo, sha) => files[sha.replace(/^sha:/, '')],
    file: async (repo, path) => (repo === P ? files[path] ?? null : null),
    openPulls: async (repo) => (repo === P ? pulls : []),
    pullMergeable: async () => true,
    pullFiles: async () => ['services/gateway/src/services/project-manager/decide.ts', '.kiro/specs/kiro-autonomy-fallback/lanes/pm-fallback.md'],
    pullCommits: async () => commits,
    commitFiles: async () => ['.kiro/specs/kiro-autonomy-fallback/lanes/pm-fallback.md'],
    checkRuns: async () => checks,
    behindBy: async () => 2,
    variable: async () => 'false',
    refDate: async (_repo, ref) => (ref.startsWith('collab-claim/') ? '2026-10-20T19:15:00Z' : null),
    commitsSince: async () => [],
    ...o,
  };
}

function data(o: Partial<PmDataReader> = {}): PmDataReader {
  return {
    verifyPassed: async () => ({}),
    gate2SentVtids: async () => new Set<string>(),
    ledgerStatus: async () => ({ 'VTID-05274': 'scheduled' }),
    sparringSession: async () => null,
    ...o,
  };
}

describe('parsers', () => {
  it('parseTrailers reads the §4.1 trailers', () => {
    const t = parseTrailers('x\n\nCollab-Session: s\nCollab-Review: a/b\nCollab-Verdict: accept\nCollab-Reviewed-Head: abc');
    expect(t).toMatchObject({ 'Collab-Session': 's', 'Collab-Review': 'a/b', 'Collab-Verdict': 'accept', 'Collab-Reviewed-Head': 'abc' });
  });
  it('parseLaneLog splits executing entries, review entries and decisions', () => {
    const log = parseLaneLog(LANE);
    expect(log.entries.map((e) => e.session)).toEqual(['kiro-exafy-202610201807-2a87', 'agent-vitana-lane-reviewer-202610201940-abcd']);
    expect(log.reviews).toEqual([expect.objectContaining({ session: 'agent-vitana-lane-reviewer-202610201940-abcd', verdict: 'accept', head: C2, reviewer: 'agent:vitana-lane-reviewer (claude-sonnet-5.5)' })]);
    expect(log.decisions).toEqual(['kept pmMode() default', 'no webhook receiver']);
  });
  it('parseLaneLog accepts the " - " separator', () => {
    const log = parseLaneLog(`## Log\n### 2026-10-20T19:10Z - agent:vitana-lane-reviewer - in-review -> review accept\nreview: accept\nhead: ${C2}\n`);
    expect(log.reviews).toEqual([expect.objectContaining({ session: 'agent:vitana-lane-reviewer', verdict: 'accept', head: C2 })]);
  });
  it('reviewOnlySince: heads after which only review / pm-agent lane commits follow', async () => {
    const r = reader();
    const commits = await r.pullCommits(P, 1);
    const since = await reviewOnlySince(r, P, commits, 'kiro-autonomy-fallback/pm-fallback', '.kiro/specs/kiro-autonomy-fallback/lanes/pm-fallback.md');
    expect(since.sort()).toEqual([C2, C3].sort());
  });
  it('reviewOnlySince stops at a commit that changes another file', async () => {
    const r = reader({ commitFiles: async (_r, sha) => (sha === HEAD ? ['services/gateway/src/x.ts'] : ['.kiro/specs/kiro-autonomy-fallback/lanes/pm-fallback.md']) });
    const commits = await r.pullCommits(P, 1);
    expect(await reviewOnlySince(r, P, commits, 'kiro-autonomy-fallback/pm-fallback', '.kiro/specs/kiro-autonomy-fallback/lanes/pm-fallback.md')).toEqual([]);
  });
});

describe('GithubObserver', () => {
  it('builds lanes, PR, reviews (trailers win), review_only_since, behind_by, ledger, claim, rotations and Claude flag', async () => {
    const o = new GithubObserver({ gh: reader(), data: data(), repos: [P], now: () => NOW, env: {} });
    const s = await o.observe('live');
    expect(s.mode).toBe('live');
    expect(s.rotations).toEqual([{ area: 'platform', seats: ['exafy'] }, { area: 'messenger', seats: ['exafyltd'] }]);
    const l = s.lanes.find((x) => x.lane === 'pm-fallback')!;
    expect(l).toMatchObject({ slug: 'kiro-autonomy-fallback', vtid: 'VTID-05274', state: 'in-review', seat: 'exafy', reviewer_seat: 'exafyltd', depends_on: ['scope-check'], deploys: true, ledger_status: 'scheduled', claimed_at: '2026-10-20T19:15:00Z', driver_heartbeat_at: null, repo: P });
    expect(l.pr).toMatchObject({ url: `https://github.com/${P}/pull/4240`, head_sha: HEAD, mergeable: true, behind_by: 2 });
    expect(l.pr!.review_only_since.sort()).toEqual([C2, C3].sort());
    expect(l.reviews).toEqual([expect.objectContaining({ verdict: 'accept', head_sha: C2, reviewer: 'agent:vitana-lane-reviewer (claude-sonnet-5.5)', session_id: 'agent-vitana-lane-reviewer-202610201940-abcd' })]);
    expect(l.executing_log.map((e) => e.session_id)).toEqual(['kiro-exafy-202610201807-2a87']);
    expect(l.decisions_taken).toEqual(['kept pmMode() default', 'no webhook receiver']);
    expect(s.lanes.find((x) => x.lane === 'scope-check')).toMatchObject({ state: 'done' });
    expect(s.claude).toMatchObject({ flag: false });
  });

  it('variable unreadable → env CLAUDE_AVAILABLE fallback, else null', async () => {
    const bad = reader({ variable: async () => { throw new Error('403'); } });
    const a = await new GithubObserver({ gh: bad, data: data(), repos: [P], now: () => NOW, env: { CLAUDE_AVAILABLE: 'false' } }).observe('live');
    expect(a.claude!.flag).toBe(false);
    const b = await new GithubObserver({ gh: bad, data: data(), repos: [P], now: () => NOW, env: {} }).observe('live');
    expect(b.claude!.flag).toBeNull();
  });

  it('4 h rule inputs: oldest item with next_actor claude, newest session_ commit', async () => {
    const r = reader({ commitsSince: async () => [{ sha: 'x', message: 'm\n\nCollab-Session: session_abc', date: '2026-10-20T18:00:00Z' }] });
    const s = await new GithubObserver({ gh: r, data: data(), repos: [P], now: () => NOW, env: {} }).observe('live');
    // scope-check is done → not an open claude item; no other claude items.
    expect(s.claude).toMatchObject({ oldest_assigned_at: null });
    const LANE2 = LANE.replace('next_actor: kiro', 'next_actor: claude');
    const r2 = reader({
      blob: async (_x, sha) => (sha.endsWith('pm-fallback.md') ? LANE2 : (await reader().blob(P, sha))),
      commitsSince: async () => [{ sha: 'x', message: 'm\n\nCollab-Session: session_abc', date: '2026-10-20T19:50:00Z' }],
    });
    const s2 = await new GithubObserver({ gh: r2, data: data(), repos: [P], now: () => NOW, env: {} }).observe('live');
    expect(s2.claude).toMatchObject({ oldest_assigned_at: new Date(Date.parse('2026-10-20T19:30Z')).toISOString(), last_action_at: '2026-10-20T19:50:00.000Z' });
  });

  it('driver heartbeat ref: committer date read; a lane PR that fails to load is dropped, not thrown', async () => {
    const r = reader({
      refDate: async (_r, ref) => (ref === 'collab-driver/kiro-autonomy-fallback' ? '2026-10-20T19:58:00Z' : null),
      pullFiles: async () => { throw new Error('502'); },
    });
    const s = await new GithubObserver({ gh: r, data: data(), repos: [P], now: () => NOW, env: {} }).observe('live');
    const l = s.lanes.find((x) => x.lane === 'pm-fallback')!;
    expect(l.driver_heartbeat_at).toBe('2026-10-20T19:58:00Z');
    expect(l.pr).toBeNull();
  });

  it('staging verify + gate2 sent are read from the data reader', async () => {
    const LANE3 = LANE.replace('state: in-review', 'state: done');
    const r = reader({ blob: async (_x, sha) => (sha.endsWith('pm-fallback.md') ? LANE3 : (await reader().blob(P, sha))) });
    const s = await new GithubObserver({
      gh: r,
      data: data({ verifyPassed: async () => ({ 'VTID-05274': '2026-10-20T19:55:00Z' }), gate2SentVtids: async () => new Set(['VTID-05274']) }),
      repos: [P], now: () => NOW, env: {},
    }).observe('live');
    expect(s.lanes.find((x) => x.lane === 'pm-fallback')).toMatchObject({ staging_verified: true, staging_verified_at: '2026-10-20T19:55:00Z', gate2_sent: true });
  });
});

// VTID-05281 (kaf-fallback-env/ff-pm-flag): the REST reader's CLAUDE_AVAILABLE
// read and the env fallback (plan kaf-fallback-env §3, §5 B). fetch is spied;
// nothing leaves the process.
describe('GithubRestReader.variable + env fallback (VTID-05281)', () => {
  const savedToken = process.env.GITHUB_SAFE_MERGE_TOKEN;
  let fetchSpy: jest.SpyInstance;

  const respond = (status: number, body: unknown) =>
    ({ status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) }) as unknown as Response;
  const fetchReturns = (status: number, body?: unknown) => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => respond(status, body));
  };
  /** The test reader with `variable` = the real REST reader over the spied fetch. */
  const restVariableReader = (o: Partial<GithubReader> = {}) => {
    const rest = new GithubRestReader();
    return reader({ variable: (repo, name) => rest.variable(repo, name), ...o });
  };

  beforeEach(() => {
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'test-token-not-real';
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    if (savedToken === undefined) delete process.env.GITHUB_SAFE_MERGE_TOKEN;
    else process.env.GITHUB_SAFE_MERGE_TOKEN = savedToken;
  });

  it('B1: rejects on a 404 (unset or no access — unreadable)', async () => {
    fetchReturns(404, { message: 'Not Found' });
    await expect(new GithubRestReader().variable(P, 'CLAUDE_AVAILABLE')).rejects.toThrow(/404/);
  });

  it('B2: resolves the value on a 200 with a string value', async () => {
    fetchReturns(200, { name: 'CLAUDE_AVAILABLE', value: 'false' });
    await expect(new GithubRestReader().variable(P, 'CLAUDE_AVAILABLE')).resolves.toBe('false');
    expect(String(fetchSpy.mock.calls[0][0])).toBe(`https://api.github.com/repos/${P}/actions/variables/CLAUDE_AVAILABLE`);
  });

  it('B3: rejects on a 403', async () => {
    fetchReturns(403, { message: 'Resource not accessible by integration' });
    await expect(new GithubRestReader().variable(P, 'CLAUDE_AVAILABLE')).rejects.toThrow(/403/);
  });

  it('B4: a 404 on the variable → observer uses env CLAUDE_AVAILABLE=false', async () => {
    fetchReturns(404, { message: 'Not Found' });
    const s = await new GithubObserver({ gh: restVariableReader(), data: data(), repos: [P], now: () => NOW, env: { CLAUDE_AVAILABLE: 'false' } }).observe('live');
    expect(s.claude!.flag).toBe(false);
  });

  it('B5: a 404 + env true → true; a 404 + no env → null', async () => {
    fetchReturns(404, { message: 'Not Found' });
    const a = await new GithubObserver({ gh: restVariableReader(), data: data(), repos: [P], now: () => NOW, env: { CLAUDE_AVAILABLE: 'true' } }).observe('live');
    expect(a.claude!.flag).toBe(true);
    const b = await new GithubObserver({ gh: restVariableReader(), data: data(), repos: [P], now: () => NOW, env: {} }).observe('live');
    expect(b.claude!.flag).toBeNull();
  });

  it('B6: a readable variable wins over the env', async () => {
    fetchReturns(200, { name: 'CLAUDE_AVAILABLE', value: 'true' });
    const s = await new GithubObserver({ gh: restVariableReader(), data: data(), repos: [P], now: () => NOW, env: { CLAUDE_AVAILABLE: 'false' } }).observe('live');
    expect(s.claude!.flag).toBe(true);
  });

  it('B7: the 4 h rule still applies — 404 + env true + a claude item > 4 h old with no session_ commit → no_action_4h', async () => {
    fetchReturns(404, { message: 'Not Found' });
    const OLD = LANE.replace('next_actor: kiro', 'next_actor: claude').replace('updated: 2026-10-20T19:30Z', 'updated: 2026-10-20T14:00Z');
    const r = restVariableReader({
      blob: async (_x, sha) => (sha.endsWith('pm-fallback.md') ? OLD : (await reader().blob(P, sha))),
      commitsSince: async () => [],
    });
    const s = await new GithubObserver({ gh: r, data: data(), repos: [P], now: () => NOW, env: { CLAUDE_AVAILABLE: 'true' } }).observe('live');
    expect(s.claude!.flag).toBe(true);
    expect(claudeAvailability(s.claude, NOW)).toEqual({ available: false, reason: 'no_action_4h' });
  });
});

describe('applyLaneChange + GithubRepoFileWriter (W1 / W2, Collab-Session pm-agent)', () => {
  it('applyLaneChange edits only the allowed keys and appends one log entry', () => {
    const out = applyLaneChange(LANE, { slug: 'kiro-autonomy-fallback', lane: 'pm-fallback', state: 'parked', next_actor: 'exafyltd', seat: 'jtadic', release_claim: true, log: 'park (stale_claim)' }, '2026-10-20T20:00:00.000Z');
    expect(out).toMatch(/^state: parked$/m);
    expect(out).toMatch(/^parked_from: in-review$/m);
    // next_actor is claude|kiro|owner (queue.mjs validateLane): the exceptions seat is a Kiro actor.
    expect(out).toMatch(/^next_actor: kiro$/m);
    expect(out).toMatch(/^seat: jtadic$/m);
    expect(out).toMatch(/^updated: 2026-10-20T20:00Z$/m);
    expect(out).toMatch(/### 2026-10-20T20:00Z · pm-agent · in-review → parked\npark \(stale_claim\)\n$/);
    expect(out).toContain('reviewer_seat: exafyltd');
    expect(out).toContain('vtid: VTID-05274');
  });

  function fakeClient() {
    const puts: Array<{ repo: string; path: string; branch: string; message: string; text: string }> = [];
    const refs: Record<string, string> = { main: 'm'.repeat(40) };
    const pulls: Array<{ head: string; title: string }> = [];
    const client: GithubWriteClient = {
      file: async (_r, path) => (path.endsWith('handoff.md') ? { text: HANDOFF, sha: 'hs' } : { text: LANE, sha: 'ls' }),
      put: async (repo, path, branch, text, _sha, message) => { puts.push({ repo, path, branch, message, text }); },
      pullHead: async () => ({ ref: 'kiro/kiro-autonomy-fallback/pm-fallback', sha: HEAD }),
      refSha: async (_r, b) => refs[b] ?? null,
      createRef: async (_r, b, sha) => { refs[b] = sha; },
      findOpenPull: async (_r, head) => (pulls.find((p) => p.head === head) ? 'url' : null),
      createPull: async (_r, head, _b, title) => { pulls.push({ head, title }); return 'url'; },
    };
    return { client, puts, refs, pulls };
  }

  it('W1 (verify) commits on the lane PR branch with Collab-Lane <slug>/<lane>', async () => {
    const f = fakeClient();
    await new GithubRepoFileWriter(f.client, { now: () => NOW }).write({ slug: 'kiro-autonomy-fallback', lane: 'pm-fallback', state: 'verified', target: 'pr_branch', pr_url: `https://github.com/${P}/pull/4240`, log: 'agent accept on head' });
    expect(f.puts).toHaveLength(1);
    expect(f.puts[0]).toMatchObject({ repo: P, branch: 'kiro/kiro-autonomy-fallback/pm-fallback', path: '.kiro/specs/kiro-autonomy-fallback/lanes/pm-fallback.md' });
    expect(f.puts[0].message).toMatch(/\n\nCollab-Session: pm-agent\nCollab-Lane: kiro-autonomy-fallback\/pm-fallback$/);
    expect(f.pulls).toHaveLength(0);
  });

  it('W2 (bookkeeping) commits on pm-agent/<slug> with Collab-Lane <slug>/_plan and opens the PR once', async () => {
    const f = fakeClient();
    const w = new GithubRepoFileWriter(f.client, { now: () => NOW });
    await w.write({ slug: 'kiro-autonomy-fallback', lane: 'pm-fallback', state: 'done', next_actor: '', log: 'merged' });
    await w.write({ slug: 'kiro-autonomy-fallback', lane: 'pm-fallback', seat: 'jtadic', next_actor: 'exafyltd', log: 'reassign' });
    expect(f.refs['pm-agent/kiro-autonomy-fallback']).toBe('m'.repeat(40));
    expect(f.puts.map((p) => p.branch)).toEqual(['pm-agent/kiro-autonomy-fallback', 'pm-agent/kiro-autonomy-fallback']);
    expect(f.puts[0].message).toMatch(/Collab-Session: pm-agent\nCollab-Lane: kiro-autonomy-fallback\/_plan$/);
    expect(f.pulls).toEqual([{ head: 'pm-agent/kiro-autonomy-fallback', title: 'VTID-05271 (kiro-autonomy-fallback/_plan): PM bookkeeping' }]);
  });
});
