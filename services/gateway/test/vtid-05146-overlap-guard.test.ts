/**
 * VTID-05146 (Dev Autopilot autonomy, Phase C): the open-PR overlap guard's
 * pure parts and its GitHub snapshot. The end-to-end hold / release / timeout,
 * frozen_scope and review fail-closed scenarios run in the operator pipeline
 * regression suite (test/vtid-04465-operator-pipeline-regression.test.ts).
 */
import {
  describeBlocks,
  findOverlaps,
  frozenHits,
  holdExpired,
  loadOpenPrFiles,
  readHold,
  resetOverlapCache,
  sameBlocks,
  type OpenPrFiles,
} from '../src/services/dev-autopilot-overlap';

const A = 'services/gateway/src/services/a.ts';
const B = 'services/gateway/src/services/b.ts';
const C = 'services/gateway/src/frontend/command-hub/app.js';

const prs: OpenPrFiles[] = [
  { number: 10, branch: 'human/a', files: [A, 'docs/x.md'], complete: true },
  { number: 11, branch: 'dev-autopilot/self', files: [A, B], complete: true },
  { number: 12, branch: 'human/c', files: [C], complete: true },
];

describe('findOverlaps', () => {
  it('lists every other open PR sharing a file, with the shared files only', () => {
    expect(findOverlaps([A, B], prs, 11)).toEqual([{ pr: 10, branch: 'human/a', files: [A] }]);
  });
  it('the PR itself never blocks itself; no shared file → no block', () => {
    expect(findOverlaps([B], prs, 11)).toEqual([]);
  });
  it('without an own PR (before the claim) every open PR counts', () => {
    expect(findOverlaps([B], prs).map((b) => b.pr)).toEqual([11]);
  });
  it('a PR whose file list hit GitHub\'s cap blocks: its full list is unknown', () => {
    const big: OpenPrFiles = { number: 13, branch: 'huge', files: [], complete: false };
    expect(findOverlaps([B], [big]).map((b) => b.pr)).toEqual([13]);
  });
});

describe('frozenHits', () => {
  it('matches globs, ignores junk entries', () => {
    expect(frozenHits([A, C], ['services/gateway/src/frontend/command-hub/**'])).toEqual([C]);
    expect(frozenHits([A, C], [])).toEqual([]);
    expect(frozenHits([A, C], [null, '', 42] as unknown)).toEqual([]);
    expect(frozenHits([A], 'not-an-array')).toEqual([]);
  });
});

describe('holdExpired', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  it('expires strictly after max hours', () => {
    expect(holdExpired('2026-10-10T12:00:00Z', 72, now)).toBe(false);
    expect(holdExpired('2026-10-10T11:59:00Z', 72, now)).toBe(true);
  });
  it('an unreadable start counts as expired; a bad limit falls back to 72 h', () => {
    expect(holdExpired(undefined, 72, now)).toBe(true);
    expect(holdExpired('garbage', 72, now)).toBe(true);
    expect(holdExpired('2026-10-11T12:00:00Z', 0, now)).toBe(false);
  });
});

describe('sameBlocks / readHold / describeBlocks', () => {
  it('sameBlocks ignores order, sees file changes', () => {
    const x = [{ pr: 2, branch: 'b', files: [B] }, { pr: 1, branch: 'a', files: [A] }];
    expect(sameBlocks(x, [...x].reverse())).toBe(true);
    expect(sameBlocks(x, [{ pr: 1, branch: 'a', files: [A, B] }, { pr: 2, branch: 'b', files: [B] }])).toBe(false);
    expect(sameBlocks(undefined, [])).toBe(true);
  });
  it('readHold accepts only a well-formed record', () => {
    expect(readHold({ overlap_hold: { from: 'ci', held_at: 't', blocking_prs: [] } })?.from).toBe('ci');
    expect(readHold({ overlap_hold: { from: 'merging' } })).toBeNull();
    expect(readHold(null)).toBeNull();
  });
  it('describeBlocks names PRs and frozen files', () => {
    expect(describeBlocks([{ pr: 10, branch: 'h', files: [A] }], [C])).toBe(`open PR #10 (${A}) and frozen scope (${C})`);
  });
});

describe('loadOpenPrFiles', () => {
  beforeEach(() => resetOverlapCache());

  it('lists every open PR with its complete files; one fetch per PR head', async () => {
    const getAllPrFiles = jest.fn(async (_r: string, n: number) => ({ files: n === 1 ? [A] : [B], complete: true }));
    const gh = {
      listOpenPullRequests: jest.fn(async () => ({ prs: [{ number: 1, branch: 'x', head_sha: 'h1', draft: true, title: 'x' }, { number: 2, branch: 'y', head_sha: 'h2', draft: false, title: 'y' }], complete: true })),
      getAllPrFiles,
    };
    const first = await loadOpenPrFiles('o/r', gh);
    expect(first).toEqual({ ok: true, prs: [{ number: 1, branch: 'x', files: [A], complete: true }, { number: 2, branch: 'y', files: [B], complete: true }] });
    await loadOpenPrFiles('o/r', gh);
    expect(getAllPrFiles).toHaveBeenCalledTimes(2); // cached by head sha
  });

  it('never reports "no overlap" when GitHub fails or the PR list is incomplete', async () => {
    const failing = { listOpenPullRequests: jest.fn(async () => { throw new Error('GitHub 502'); }), getAllPrFiles: jest.fn() };
    expect(await loadOpenPrFiles('o/r', failing as any)).toEqual({ ok: false, error: 'GitHub 502' });
    const tooMany = { listOpenPullRequests: jest.fn(async () => ({ prs: [], complete: false })), getAllPrFiles: jest.fn() };
    expect((await loadOpenPrFiles('o/r', tooMany as any)).ok).toBe(false);
    const filesFail = {
      listOpenPullRequests: jest.fn(async () => ({ prs: [{ number: 3, branch: 'z', head_sha: 'h3', draft: false, title: 'z' }], complete: true })),
      getAllPrFiles: jest.fn(async () => { throw new Error('GitHub 500'); }),
    };
    expect((await loadOpenPrFiles('o/r', filesFail as any)).ok).toBe(false);
  });
});
