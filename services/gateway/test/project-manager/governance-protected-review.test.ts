/**
 * VTID-05780 (plan autonomous-to-staging-r2, lane protect-gate-workflow) — the two-model exact-head rule for
 * protected gate files in the Project Manager. Runs the shared cases of
 * scripts/collab/fixtures/protected-review-cases.json (also run by scripts/collab/land-guard.test.mjs); each case
 * must give the same verdict here as in land-guard.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  REVIEWER_AGENT,
  governanceMergeAllowed,
  protectedAcceptModels,
} from '../../src/services/project-manager/governance';
import type { ObservedLane, ObservedPr, ReviewEntry } from '../../src/services/project-manager/types';

interface Case {
  name: string;
  commits: { id: string; kind: 'code' | 'lane' | 'merge' }[];
  builders: string[];
  reviews: { reviewed: string; model: string; session: string }[];
  expect: 'allow' | 'refuse';
}
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', 'scripts', 'collab', 'fixtures', 'protected-review-cases.json'), 'utf8'),
) as { lane: string; protected_file: string; cases: Case[] };

const shaOf = (id: string) => (Buffer.from(id).toString('hex') + '0'.repeat(40)).slice(0, 40);
const AT = '2026-11-12T20:00:00.000Z';

function observed(c: Case): { lane: ObservedLane; pr: ObservedPr } {
  const [slug, laneId] = FIXTURE.lane.split('/');
  const head = shaOf(c.commits[c.commits.length - 1].id);
  const pr: ObservedPr = {
    url: 'https://github.com/exafyltd/vitana-platform/pull/1',
    title: `VTID-05780 (${FIXTURE.lane}): x`,
    head_sha: head,
    checks: [],
    mergeable: true,
    merged: false,
    consecutive_ci_failures: 0,
    review_only_since: [],
    files: [FIXTURE.protected_file],
    behind_by: 0,
  };
  const reviews: ReviewEntry[] = c.reviews.map((r) => ({
    session_id: r.session,
    reviewer_seat: 'agent:vitana-lane-reviewer',
    verdict: 'accept',
    head_sha: shaOf(r.reviewed),
    at: AT,
    reviewer: `${REVIEWER_AGENT} (${r.model})`,
  }));
  const lane = {
    slug,
    lane: laneId,
    vtid: 'VTID-05780',
    state: 'verified',
    seat: 'exafy',
    reviewer_seat: 'agent:vitana-lane-reviewer',
    area: 'platform',
    paths: [FIXTURE.protected_file],
    depends_on: [],
    pr,
    reviews,
    executing_log: c.builders.map((s) => ({ session_id: s, seat: 'exafy', at: AT })),
    state_since: AT,
    last_branch_activity: null,
  } as unknown as ObservedLane;
  return { lane, pr };
}

describe('VTID-05780 shared protected-review fixtures (same verdict as land-guard.test.mjs)', () => {
  it('has the seven cases', () => {
    expect(FIXTURE.cases).toHaveLength(7);
  });
  for (const c of FIXTURE.cases) {
    it(`${c.expect}: ${c.name}`, () => {
      const { lane, pr } = observed(c);
      const v = governanceMergeAllowed(lane, pr, lane.reviews[lane.reviews.length - 1] ?? null, lane.reviews);
      expect(v.ok ? 'allow' : 'refuse').toBe(c.expect);
    });
  }
});

describe('VTID-05780 protectedAcceptModels: exact head, distinct sessions, builders excluded', () => {
  const head = shaOf('h');
  const pr = { head_sha: head, review_only_since: [shaOf('old')] } as unknown as ObservedPr;
  const r = (model: string, session: string, at = head): ReviewEntry => ({
    session_id: session,
    reviewer_seat: 'agent:vitana-lane-reviewer',
    verdict: 'accept',
    head_sha: at,
    at: AT,
    reviewer: `${REVIEWER_AGENT} (${model})`,
  });
  it('two models in two sessions count', () => {
    expect(protectedAcceptModels([r('claude-sonnet-5.5', 'a1'), r('claude-opus-5.5', 'a2')], pr).sort()).toEqual(['claude-opus-5.5', 'claude-sonnet-5.5']);
  });
  it('review_only_since is not used for protected files (exact head only)', () => {
    expect(protectedAcceptModels([r('claude-sonnet-5.5', 'a1'), r('claude-opus-5.5', 'a2', shaOf('old'))], pr)).toHaveLength(1);
  });
  it('one session with two models, a builder session or an empty session never makes a pair', () => {
    expect(protectedAcceptModels([r('claude-sonnet-5.5', 'a1'), r('claude-opus-5.5', 'a1')], pr)).toHaveLength(1);
    expect(protectedAcceptModels([r('claude-sonnet-5.5', 'a1'), r('claude-opus-5.5', 'b1')], pr, ['b1'])).toHaveLength(1);
    expect(protectedAcceptModels([r('claude-sonnet-5.5', 'a1'), r('claude-opus-5.5', '')], pr)).toHaveLength(1);
  });
});
