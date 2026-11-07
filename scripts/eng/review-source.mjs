// Where the review entry of a cross-repo lane comes from (plan agentic-delivery §3.5, lane merge-queue).
//
// A vitana-v1 merge request titled `VTID-xxxxx (<slug>/<lane>): …` has its review entry in the vitana-platform lane file
// `.kiro/specs/<slug>/lanes/<lane>.md`, not on the merge request. The merge bot reads that entry from its clone of the
// platform project: `main` first, then the branches `kiro/<slug>/*` (bridged from GitHub or pushed natively). An entry is a
// commit with the trailers of collaboration.md §4.1 (Collab-Session, Collab-Review, Collab-Verdict, Collab-Reviewer,
// Collab-Reviewed-Head). The decision:
//  - no entry for the lane → no_review; the newest entry is a `changes` verdict → review_changes;
//  - of the accepts, the newest one that `reviewCurrent` (land-guard.mjs, unchanged) accepts for the merge request's own
//    commits counts (two accepts: the newest current one); none → review_stale;
//  - that accept must name the reviewer agent with a model of the reviewer chain (review_model, review_forged), come from a
//    reviewer agent session (review_forged), and its session must not appear on any commit of the merge request
//    (review_by_builder): a lane is never accepted by its builder.
// Same-repo lanes keep the merge bot's push-identity check (eng-gitlab-m2 §3.4); this module is only the cross-repo source.
// Reads git only; any git error is thrown (the caller lands nothing). Dependency-free Node 20.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { localAfter, reviewCurrent } from '../collab/land-guard.mjs';
import { commitsInRange, agentOf, REVIEWER_AGENTS } from '../collab/queue.mjs';

const require = createRequire(import.meta.url);
/** The reviewer chain (vitana-pipeline.md), read from the one list the CI guard checks (kiro-steering/guard.cjs). */
export const REVIEWER_MODELS = Object.freeze([...require('../ci/kiro-steering/guard.cjs').REVIEWER_MODELS]);

const SHA = /^[0-9a-f]{40}$/;
const REVIEWER_VALUE = /^agent:vitana-lane-reviewer \(([^()\s]+)\)$/;
const KEY = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;
const MAIN = 'refs/remotes/origin/main';
const MAX_BUFFER = 64 * 1024 * 1024;

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER }).trimEnd();

/** The model named in a `Collab-Reviewer: agent:vitana-lane-reviewer (<model>)` value, else null. */
export function reviewerModel(value) {
  const m = REVIEWER_VALUE.exec(String(value ?? '').trim());
  return m ? m[1] : null;
}

/** `<slug>/<lane>` → the lane file in vitana-platform. */
export function laneFileOf(laneKey) {
  const m = KEY.exec(String(laneKey ?? ''));
  if (!m) throw new Error(`not a lane key: "${laneKey}"`);
  return `.kiro/specs/${m[1]}/lanes/${m[2]}.md`;
}

/** The refs of the platform clone to read, in order: main, then every kiro/<slug>/* branch. Throws when main is missing. */
export function platformRefs(repo, slug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(slug ?? ''))) throw new Error(`not a slug: "${slug}"`);
  try { git(repo, ['rev-parse', '--verify', '-q', `${MAIN}^{commit}`]); } catch { throw new Error(`${repo}: no ${MAIN}: the platform project was not fetched`); }
  const branches = git(repo, ['for-each-ref', '--format=%(refname)', `refs/remotes/origin/kiro/${slug}/`]).split('\n').filter(Boolean).sort();
  return [MAIN, ...branches];
}

/**
 * The review entries of `laneKey` reachable from `refs` that touch its lane file, each read once (an entry on main and on a
 * branch is reported as main's), newest first by committer time:
 * [{ sha, ref, at, session, reviews, verdict, reviewer, model, reviewedHead }].
 */
export function reviewEntries(repo, refs, laneKey) {
  const file = laneFileOf(laneKey);
  const keys = ['Collab-Session', 'Collab-Review', 'Collab-Verdict', 'Collab-Reviewer', 'Collab-Reviewed-Head'];
  const fmt = `%x1e%H%x1f%cI${keys.map((k) => `%x1f%(trailers:key=${k},valueonly,separator=%x2c)`).join('')}`;
  const seen = new Map();
  for (const ref of refs) {
    const out = git(repo, ['log', '--no-merges', `--format=${fmt}`, ref, '--', file]);
    for (const rec of out.split('\x1e').slice(1)) {
      const [sha, at, session, review, verdict, reviewer, reviewedHead] = rec.split('\x1f').map((s) => (s || '').trim());
      const reviews = review.split(',').map((s) => s.trim()).filter(Boolean);
      if (!reviews.includes(laneKey) || !verdict || seen.has(sha)) continue;
      seen.set(sha, { sha, ref, at: new Date(at).toISOString(), session, reviews, verdict, reviewer, model: reviewerModel(reviewer), reviewedHead });
    }
  }
  return [...seen.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const newestFirst = (entries) => [...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

/**
 * The decision over a lane's entries, without IO. `current(entry)` → reviewCurrent's { ok, reason } for the entry's reviewed
 * head against the merge request's head; `mrSessions` = the Collab-Session values of the merge request's commits.
 * → { ok, code, reason, entry? }
 */
export function judgeEntries(entries, { laneKey, mrSessions = [], current }) {
  const lane = newestFirst((entries || []).filter((e) => (e.reviews || []).includes(laneKey) && (e.verdict === 'accept' || e.verdict === 'changes')));
  if (!lane.length) return { ok: false, code: 'no_review', reason: `no review entry for ${laneKey} in the platform lane file (main or kiro/<slug>/* branches)` };
  if (lane[0].verdict === 'changes') return { ok: false, code: 'review_changes', reason: `the newest review of ${laneKey} asks for changes`, entry: lane[0] };
  let firstReason = null;
  let found = null;
  for (const e of lane.filter((x) => x.verdict === 'accept')) {
    const c = SHA.test(e.reviewedHead || '') ? current(e) : { ok: false, reason: 'the accept has no valid Collab-Reviewed-Head' };
    if (c.ok) { found = e; break; }
    firstReason ??= c.reason;
  }
  if (!found) return { ok: false, code: 'review_stale', reason: `no accept of ${laneKey} counts for this head: ${firstReason}` };
  const model = found.model ?? reviewerModel(found.reviewer);
  if (!model) return { ok: false, code: 'review_forged', reason: 'the accept does not name the reviewer agent (Collab-Reviewer)', entry: found };
  if (!REVIEWER_MODELS.includes(model)) return { ok: false, code: 'review_model', reason: `the accept was made by ${model}, which is not a model of the reviewer chain (${REVIEWER_MODELS.join(', ')})`, entry: found };
  if (!REVIEWER_AGENTS.includes(agentOf(found.session))) return { ok: false, code: 'review_forged', reason: `the accept comes from session ${found.session || 'none'}, not a reviewer agent session`, entry: found };
  if (mrSessions.includes(found.session)) return { ok: false, code: 'review_by_builder', reason: `the reviewer session ${found.session} also committed to this merge request`, entry: found };
  return { ok: true, code: 'review_found', reason: `accept ${found.sha.slice(0, 8)} on ${found.ref.replace('refs/remotes/origin/', '')} counts for this head`, entry: { ...found, model } };
}

/**
 * The cross-repo review of a merge request: `platformRepo` = the bot's clone of vitana-platform (origin/main and
 * origin/kiro/<slug>/* fetched), `repo` = its clone of the merge request's project (origin/main and the head fetched).
 */
export function crossRepoReview({ platformRepo, repo, head, laneKey, base = 'origin/main' }) {
  const [slug] = String(laneKey).split('/');
  const entries = reviewEntries(platformRepo, platformRefs(platformRepo, slug), laneKey);
  const mrSessions = [...new Set(commitsInRange(repo, base, head).map((c) => c.session).filter(Boolean))];
  return judgeEntries(entries, {
    laneKey,
    mrSessions,
    current: (e) => {
      const walk = localAfter(repo, e.reviewedHead, head, laneKey);
      return reviewCurrent(e.reviewedHead, head, walk.after, laneKey, walk.prDiffSame);
    },
  });
}
