/**
 * VTID-05547 (plan agentic-delivery §3.11, tasks.md G1) — the GitLab event → delivery OASIS events mapping
 * (services/gitlab-events/delivery-mapper.ts), on top of the VTID-05541 mapper.
 *
 * Pins:
 *   - the landing and the staging deploy of a pipeline on main (live only), the queue-label update, pipeline
 *     started and canceled, the cut tags, the moved pull request, the push with its review and lane-file facts;
 *   - shadow marking, and that a shadow run writes no deploy and no landing row;
 *   - on every event: a VTID or BOOTSTRAP-DELIVERY, metadata.dedupe_key, plane delivery, host gitlab, a mode;
 *   - the privacy rule (ids, refs, shas, statuses, durations, job names, URLs and named trailers only);
 *   - that no GitLab or delivery event can move a VTID (the lifecycle mapper has no rule for any of them);
 *   - that the events of mapper.ts are kept as they are, plus the delivery fields.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  AGENT_BRANCH_RE,
  DELIVERY_TOPICS,
  MemoryBranchVtidIndex,
  jobsOf,
  laneKeyOf,
  mapGitlabDelivery,
  modeFor,
  parseTrailers,
  queueLabel,
  type DeliveryEvent,
  type DeliveryMapOptions,
} from '../../src/services/gitlab-events/delivery-mapper';
import { mapGitlabEvent } from '../../src/services/gitlab-events/mapper';
import { EVENT_MAPPING_RULES, mapEventToTransition } from '../../src/services/autopilot-event-mapper';
import type { AutopilotState } from '../../src/services/autopilot-controller';
import {
  HEAD,
  LANDING_MESSAGE,
  LANE_TITLE,
  LIVE_ENV,
  MERGE_SHA,
  REHEARSAL,
  REVIEWED,
  REVIEW_COMMIT,
  UNSET_ENV,
  V1,
  mergeRequest,
  pipeline,
  push,
  tagPush,
} from './fixtures';

async function map(payload: unknown, env: NodeJS.ProcessEnv = LIVE_ENV, extra: Partial<DeliveryMapOptions> = {}, id = 'wh_1') {
  return mapGitlabDelivery(payload, id, { env, branches: new MemoryBranchVtidIndex(), ...extra });
}
async function events(payload: unknown, env: NodeJS.ProcessEnv = LIVE_ENV, extra: Partial<DeliveryMapOptions> = {}): Promise<DeliveryEvent[]> {
  const m = await map(payload, env, extra);
  if (m.kind !== 'emit') throw new Error(`expected emit, got ${JSON.stringify(m)}`);
  return m.events;
}
const topics = (evs: DeliveryEvent[]) => evs.map((e) => e.type);
const only = (evs: DeliveryEvent[], topic: string) => evs.filter((e) => e.type === topic);

const DEPLOY_BUILDS = (deploy: string, rollback?: string) => [
  { id: 1, name: 'full-suite', stage: 'test', status: 'success', duration: 120, queued_duration: 3 },
  { id: 2, name: 'deploy-staging:gateway', stage: 'deploy', status: deploy, duration: 210.5, queued_duration: 6 },
  ...(rollback ? [{ id: 3, name: 'rollback-staging:gateway', stage: 'deploy', status: rollback, duration: 40, queued_duration: 1 }] : []),
];

describe('VTID-05547 landing — a main pipeline with the trailers gives one delivery.landed', () => {
  it('a main pipeline with the trailers gives one delivery.landed', async () => {
    const evs = await events(pipeline('success'));
    expect(topics(evs)).toEqual(['scm.gitlab.pipeline.succeeded', 'delivery.landed']);
    const landed = only(evs, 'delivery.landed');
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({
      vtid: 'VTID-05547',
      type: 'delivery.landed',
      source: 'gitlab-webhook',
      status: 'success',
      payload: {
        merge_sha: MERGE_SHA,
        merge_request: '!12',
        merge_request_iid: 12,
        source_branch: 'kiro/agentic-delivery/gateway-delivery',
        reviewed_head: REVIEWED,
        verdict: 'accept',
        reviewer: 'agent:vitana-lane-reviewer (claude-sonnet-5.5)',
        reviewer_model: 'claude-sonnet-5.5',
        accepted_at: '2026-11-05T10:00:00Z',
        landed_at: '2026-11-05T10:05:30+00:00',
        accept_to_land_s: 330,
        pipeline_id: 31,
        ref: 'main',
        lane_key: 'agentic-delivery/gateway-delivery',
        repo: 'vitana-platform',
        mode: 'live',
      },
    });
  });

  it('the landing seen at running, success and failed has the same dedupe key (one fact)', async () => {
    const keys = [];
    for (const status of ['running', 'success', 'failed']) {
      const landed = only(await events(pipeline(status)), 'delivery.landed');
      expect(landed).toHaveLength(1);
      keys.push(landed[0].payload.dedupe_key);
    }
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(`gitlab:vitana/vitana-platform:landed:${MERGE_SHA}`);
  });

  it('seconds from accept to land are null, never 0, when the trailer or the commit time is missing or odd', async () => {
    const noAccepted = LANDING_MESSAGE.replace('Accepted-At: 2026-11-05T10:00:00Z', 'Accepted-At: yesterday');
    const evs = await events(pipeline('success', { commit: { id: MERGE_SHA, title: LANE_TITLE, message: noAccepted, timestamp: '2026-11-05T10:05:30+00:00' } }));
    expect(only(evs, 'delivery.landed')[0].payload.accept_to_land_s).toBeNull();
    const earlier = pipeline('success', { commit: { id: MERGE_SHA, title: LANE_TITLE, message: LANDING_MESSAGE, timestamp: '2026-11-05T09:00:00+00:00' } });
    expect(only(await events(earlier), 'delivery.landed')[0].payload.accept_to_land_s).toBeNull();
  });

  it('a main pipeline without the Merge-Request trailer gives no delivery.landed', async () => {
    const plain = pipeline('success', { commit: { id: MERGE_SHA, title: LANE_TITLE, message: `${LANE_TITLE}\n\nReviewed-Head: ${REVIEWED}`, timestamp: '2026-11-05T10:05:30+00:00' } });
    expect(topics(await events(plain))).toEqual(['scm.gitlab.pipeline.succeeded']);
  });

  it('a pipeline of another ref, or of a tag, gives no landing and no deploy event', async () => {
    for (const attrs of [{ ref: 'kiro/agentic-delivery/gateway-delivery' }, { ref: 'main', tag: true }]) {
      const evs = await events(pipeline('success', { attrs, builds: DEPLOY_BUILDS('success') }));
      expect(topics(evs)).toEqual(['scm.gitlab.pipeline.succeeded']);
    }
  });
});

describe('VTID-05547 staging deploy — the deploy and rollback job statuses of a main pipeline', () => {
  it('the deploy job success gives staging.deploy.completed with the commit', async () => {
    const evs = await events(pipeline('success', { builds: DEPLOY_BUILDS('success') }));
    const done = only(evs, 'staging.deploy.completed');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      vtid: 'VTID-05547',
      status: 'success',
      payload: { git_commit: MERGE_SHA, branch: 'main', env: 'staging', service: 'gateway', job: 'deploy-staging:gateway', job_id: 2, pipeline_id: 31, wait_s: 6, run_s: 210.5, mode: 'live' },
    });
    expect(done[0].payload.dedupe_key).toBe('gitlab:vitana/vitana-platform:deploy:31:deploy-staging:gateway:success');
    expect(String(done[0].payload.workflow)).toContain('deploy-staging:gateway');
  });

  it('the deploy job failure gives staging.deploy.failed with status warning, never error', async () => {
    const evs = await events(pipeline('failed', { builds: DEPLOY_BUILDS('failed') }));
    const failed = only(evs, 'staging.deploy.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe('warning');
    expect(failed[0].payload.git_commit).toBe(MERGE_SHA);
    expect(only(evs, 'staging.deploy.completed')).toHaveLength(0);
  });

  it('the rollback job gives staging.deploy.rolled_back', async () => {
    const evs = await events(pipeline('success', { builds: DEPLOY_BUILDS('success', 'success') }));
    const rolled = only(evs, 'staging.deploy.rolled_back');
    expect(rolled).toHaveLength(1);
    expect(rolled[0]).toMatchObject({ status: 'warning', payload: { git_commit: MERGE_SHA, job: 'rollback-staging:gateway', service: 'gateway' } });
  });

  it('a deploy job that was canceled or skipped, and a failed rollback job, give no staging.deploy event', async () => {
    for (const builds of [DEPLOY_BUILDS('canceled'), DEPLOY_BUILDS('skipped'), DEPLOY_BUILDS('manual'), [{ id: 3, name: 'rollback-staging', status: 'failed' }]]) {
      const evs = await events(pipeline('failed', { builds }));
      expect(topics(evs).filter((t) => t.startsWith('staging.deploy.'))).toEqual([]);
    }
  });

  it('a deploy job found on a canceled pipeline still counts when it finished', async () => {
    const evs = await events(pipeline('canceled', { builds: DEPLOY_BUILDS('success') }));
    expect(topics(evs)).toEqual(['scm.gitlab.pipeline.canceled', 'staging.deploy.completed']);
  });

  it('a deploy job with no service suffix, and an unrelated job name, are read correctly', async () => {
    const evs = await events(pipeline('success', { builds: [{ id: 1, name: 'deploy-staging', status: 'success' }, { id: 2, name: 'deploy-staging-docs-check', status: 'success' }, { id: 3, name: 'predeploy-staging', status: 'success' }] }));
    const done = only(evs, 'staging.deploy.completed');
    expect(done.map((e) => e.payload.service)).toEqual([null, 'docs-check']);
  });
});

describe('VTID-05547 merge request updates — the queue label and a new head', () => {
  const update = (changes: unknown, attrs: Record<string, unknown> = {}, labels: unknown = [{ title: 'queue-ready' }]) =>
    mergeRequest('update', attrs, { changes, labels });

  it('a queue label change gives scm.gitlab.merge_request.updated', async () => {
    const evs = await events(update({ labels: { previous: [], current: [{ title: 'queue-ready' }] } }));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      vtid: 'VTID-05547',
      type: 'scm.gitlab.merge_request.updated',
      source: 'gitlab-webhook',
      status: 'info',
      task_stage: 'VALIDATOR',
      payload: { merge_request_iid: 12, queue_label: 'queue-ready', queue_label_previous: null, new_head: false, lane_key: 'agentic-delivery/gateway-delivery', head_sha: HEAD, repo: 'vitana-platform' },
    });
    expect(evs[0].payload.dedupe_key).toBe('gitlab:vitana/vitana-platform:merge_request:12:updated:2026-11-05 10:00:00 UTC');
  });

  it('moving from one queue label to another records both', async () => {
    const evs = await events(update({ labels: { previous: [{ title: 'queue-ready' }, { title: 'bug' }], current: [{ title: 'queue-updating' }, { title: 'bug' }] } }, {}, [{ title: 'queue-updating' }]));
    expect(evs[0].payload).toMatchObject({ queue_label: 'queue-updating', queue_label_previous: 'queue-ready' });
  });

  it('a new head (oldrev) gives scm.gitlab.merge_request.updated with new_head true', async () => {
    const evs = await events(update(undefined, { oldrev: '1111111111111111111111111111111111111111' }));
    expect(evs[0]).toMatchObject({ type: 'scm.gitlab.merge_request.updated', payload: { new_head: true, previous_head_sha: '1111111111111111111111111111111111111111' } });
  });

  it('an update that changes neither the queue label nor the head is ignored (unmapped_action)', async () => {
    expect(await map(update({ title: { previous: 'a', current: 'b' } }))).toEqual({ kind: 'ignore', reason: 'unmapped_action' });
    expect(await map(update({ labels: { previous: [{ title: 'bug' }], current: [{ title: 'bug' }, { title: 'docs' }] } }))).toEqual({ kind: 'ignore', reason: 'unmapped_action' });
  });

  it('an update without a VTID in the title is ignored (no_vtid)', async () => {
    const m = await map(update({ labels: { previous: [], current: [{ title: 'queue-ready' }] } }, { title: 'no ticket here' }));
    expect(m).toEqual({ kind: 'ignore', reason: 'no_vtid' });
  });

  it('opened, merged and closed keep the events of mapper.ts and add the lane key and the queue label', async () => {
    for (const [action, topic] of [['open', 'scm.gitlab.merge_request.opened'], ['merge', 'scm.gitlab.merge_request.merged'], ['close', 'scm.gitlab.merge_request.closed']]) {
      const evs = await events(mergeRequest(action, {}, { labels: [{ title: 'queue-waiting' }] }));
      expect(evs[0].type).toBe(topic);
      expect(evs[0].payload).toMatchObject({ lane_key: 'agentic-delivery/gateway-delivery', queue_label: 'queue-waiting', repo: 'vitana-platform' });
    }
  });
});

describe('VTID-05547 pipelines — started, canceled, finished, and the job summary', () => {
  it('pipeline running and canceled give scm.gitlab.pipeline.started and .canceled', async () => {
    const started = await events(pipeline('running', { attrs: { ref: 'kiro/x/y' }, merge_request: { iid: 12, title: LANE_TITLE } }));
    expect(started[0]).toMatchObject({ type: 'scm.gitlab.pipeline.started', status: 'info', vtid: 'VTID-05547', message: 'GitLab pipeline 31 started on kiro/x/y in vitana/vitana-platform' });
    const canceled = await events(pipeline('canceled', { attrs: { ref: 'kiro/x/y' }, merge_request: { iid: 12, title: LANE_TITLE } }));
    expect(canceled[0]).toMatchObject({ type: 'scm.gitlab.pipeline.canceled', status: 'info', vtid: 'VTID-05547' });
    expect(canceled[0].payload.dedupe_key).toBe('gitlab:vitana/vitana-platform:pipeline:31:canceled');
  });

  it('other pipeline statuses are ignored (unmapped_status)', async () => {
    for (const status of ['pending', 'created', 'skipped', 'manual', 'scheduled', 'preparing', undefined]) {
      expect(await map(pipeline(status as string))).toEqual({ kind: 'ignore', reason: 'unmapped_status' });
    }
  });

  it('success and failed with no VTID in either title use BOOTSTRAP-DELIVERY (a nightly run)', async () => {
    const nightly = pipeline('failed', { attrs: { source: 'schedule' }, commit: { id: MERGE_SHA, title: 'chore: nothing', message: 'chore: nothing' } });
    const evs = await events(nightly);
    expect(evs[0]).toMatchObject({ vtid: 'BOOTSTRAP-DELIVERY', type: 'scm.gitlab.pipeline.failed', status: 'warning' });
    const ok = await events(pipeline('success', { attrs: { source: 'schedule' }, commit: { id: MERGE_SHA, title: 'chore: nothing', message: 'chore: nothing' } }));
    expect(ok[0]).toMatchObject({ vtid: 'BOOTSTRAP-DELIVERY', type: 'scm.gitlab.pipeline.succeeded', status: 'success' });
  });

  it('the VTID of a pipeline is the merge request title first, then the commit title', async () => {
    const both = pipeline('success', { attrs: { ref: 'b' }, merge_request: { iid: 3, title: 'VTID-00001 first' }, commit: { id: 'x', title: 'VTID-00002 second', message: '' } });
    expect((await events(both))[0].vtid).toBe('VTID-00001');
    const commitOnly = pipeline('success', { attrs: { ref: 'b' }, merge_request: { iid: 3, title: 'no ticket' }, commit: { id: 'x', title: 'VTID-00002 second', message: '' } });
    expect((await events(commitOnly))[0].vtid).toBe('VTID-00002');
  });

  it("pipeline events carry each job's name, status, wait and run seconds, and nothing else of the builds", async () => {
    const evs = await events(pipeline('success', { attrs: { ref: 'b' }, builds: [{ id: 9, name: 'lint', stage: 'test', status: 'success', duration: 12.5, queued_duration: 1.5, runner: { description: 'secret-runner' }, user: { name: 'secret-user' }, artifacts_file: { filename: 'secret.zip' } }] }));
    expect(evs[0].payload.jobs).toEqual([{ name: 'lint', stage: 'test', status: 'success', wait_s: 1.5, run_s: 12.5 }]);
    expect(evs[0].payload).toMatchObject({ duration_s: 63, queued_s: 4 });
    const text = JSON.stringify(evs);
    for (const leak of ['secret-runner', 'secret-user', 'secret.zip']) expect(text).not.toContain(leak);
  });

  it('jobsOf bounds the list and tolerates odd input', () => {
    expect(jobsOf(undefined)).toEqual([]);
    expect(jobsOf('x')).toEqual([]);
    expect(jobsOf([null, 3, { name: 7, status: {} }])).toEqual([{ name: null, stage: null, status: null, wait_s: null, run_s: null }]);
    expect(jobsOf(Array.from({ length: 300 }, (_v, i) => ({ name: `j${i}` })))).toHaveLength(100);
  });
});

describe('VTID-05547 cut tags and moved pull requests', () => {
  it('the tags delivery/cutover-<repo> give scm.migration.cutover', async () => {
    for (const repo of ['vitana-platform', 'vitana-v1']) {
      const evs = await events(tagPush(`refs/tags/delivery/cutover-${repo}`));
      expect(evs).toHaveLength(1);
      expect(evs[0]).toMatchObject({
        vtid: 'BOOTSTRAP-DELIVERY',
        type: 'scm.migration.cutover',
        status: 'info',
        payload: { cutover_repo: repo, tag: `delivery/cutover-${repo}`, sha: MERGE_SHA, mode: 'live', plane: 'delivery', host: 'gitlab' },
      });
      expect(evs[0].payload.dedupe_key).toBe(`gitlab:vitana/vitana-platform:tag:delivery/cutover-${repo}`);
    }
  });

  it('another tag, a tag of another repository, and a deleted tag are ignored', async () => {
    for (const ref of ['refs/tags/v1.0.0', 'refs/tags/delivery/cutover-rehearsal', 'refs/tags/delivery/cutover-vitana-v1-x', 'refs/heads/delivery/cutover-vitana-v1']) {
      expect(await map(tagPush(ref))).toEqual({ kind: 'ignore', reason: 'unmapped_ref' });
    }
    expect(await map(tagPush('refs/tags/delivery/cutover-vitana-v1', { checkout_sha: null, after: '0'.repeat(40) }))).toEqual({ kind: 'ignore', reason: 'unmapped_action' });
  });

  it('a merge request opened with a "Moved from <PR URL>" line gives scm.migration.pr_moved, next to scm.gitlab.merge_request.opened', async () => {
    const description = 'Body.\n\nMoved from https://github.com/exafyltd/vitana-v1/pull/777\n\nsecret-description-text';
    const evs = await events(mergeRequest('open', { description }, {}, V1));
    expect(topics(evs)).toEqual(['scm.gitlab.merge_request.opened', 'scm.migration.pr_moved']);
    expect(evs[1]).toMatchObject({
      vtid: 'VTID-05547',
      payload: { github_pr_url: 'https://github.com/exafyltd/vitana-v1/pull/777', github_repo: 'vitana-v1', github_pr_number: 777, merge_request_iid: 12, repo: 'vitana-v1' },
    });
    expect(evs[1].payload.dedupe_key).toBe('gitlab:vitana/vitana-v1:pr_moved:12:777');
    expect(JSON.stringify(evs)).not.toContain('secret-description-text');
  });

  it('a moved plan pull request with no VTID in its title still gives scm.migration.pr_moved, under BOOTSTRAP-DELIVERY', async () => {
    const m = await map(mergeRequest('open', { title: 'plan(agentic-delivery): x', description: 'Moved from https://github.com/exafyltd/vitana-platform/pull/4680' }));
    expect(m.kind).toBe('emit');
    if (m.kind === 'emit') expect(m.events.map((e) => [e.type, e.vtid])).toEqual([['scm.migration.pr_moved', 'BOOTSTRAP-DELIVERY']]);
  });

  it('only a GitHub pull request of the two repositories counts as moved', async () => {
    for (const description of ['Moved from https://example.com/exafyltd/vitana-v1/pull/7', 'Moved from https://github.com/other/vitana-v1/pull/7', 'moved from https://github.com/exafyltd/vitana-v1/pull/7', 'see Moved from https://github.com/exafyltd/vitana-v1/pull/7']) {
      const evs = await events(mergeRequest('open', { description }));
      expect(topics(evs)).toEqual(['scm.gitlab.merge_request.opened']);
    }
  });
});

describe('VTID-05547 push — the branch, its merge request and the review and lane-file facts', () => {
  it("a push to an agent branch gives scm.gitlab.push with the VTID of its branch's merge request", async () => {
    const branches = new MemoryBranchVtidIndex();
    // The merge request of the branch was seen first, by this task.
    await mapGitlabDelivery(mergeRequest('open'), 'wh_mr', { env: LIVE_ENV, branches });
    const evs = await events(push({ commits: [{ id: HEAD, title: 'wip', message: 'wip\n\nCollab-Session: kiro-exafy-1\nCollab-Lane: agentic-delivery/gateway-delivery', modified: [] }] }), LIVE_ENV, { branches });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      vtid: 'VTID-05547',
      type: 'scm.gitlab.push',
      source: 'gitlab-webhook',
      status: 'info',
      payload: { branch: 'kiro/agentic-delivery/gateway-delivery', head_sha: HEAD, before: '1111111111111111111111111111111111111111', commits: 1, session: 'kiro-exafy-1', lane_key: 'agentic-delivery/gateway-delivery', repo: 'vitana-platform' },
    });
    expect(evs[0].payload.dedupe_key).toBe(`gitlab:vitana/vitana-platform:push:kiro/agentic-delivery/gateway-delivery:${HEAD}`);
  });

  it('a branch this task has not seen is looked up through the injected lookup; a failing lookup falls back to the commit titles, then BOOTSTRAP-DELIVERY', async () => {
    const seen: Array<[string | null, string]> = [];
    const lookup = async (project: string | null, branch: string) => { seen.push([project, branch]); return 'VTID-00777'; };
    const viaLookup = await events(push(), LIVE_ENV, { lookupBranchVtid: lookup });
    expect(viaLookup[0].vtid).toBe('VTID-00777');
    expect(seen).toEqual([['vitana/vitana-platform', 'kiro/agentic-delivery/gateway-delivery']]);

    const failing = async () => { throw new Error('upstream down'); };
    expect((await events(push(), LIVE_ENV, { lookupBranchVtid: failing }))[0].vtid).toBe('VTID-05547'); // from the commit title
    const untitled = push({ commits: [{ id: HEAD, title: 'wip', message: 'wip', modified: [] }] });
    expect((await events(untitled, LIVE_ENV, { lookupBranchVtid: failing }))[0].vtid).toBe('BOOTSTRAP-DELIVERY');
    expect((await events(untitled))[0].vtid).toBe('BOOTSTRAP-DELIVERY');
  });

  it('the index is not asked twice for a branch it knows, and a lookup is not used when the index has the VTID', async () => {
    const branches = new MemoryBranchVtidIndex();
    branches.remember('vitana/vitana-platform', 'kiro/agentic-delivery/gateway-delivery', 'VTID-00123');
    const lookup = jest.fn(async () => 'VTID-00999');
    const evs = await events(push(), LIVE_ENV, { branches, lookupBranchVtid: lookup });
    expect(evs[0].vtid).toBe('VTID-00123');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a pushed commit with Collab-Verdict gives one delivery.review.recorded', async () => {
    const evs = await events(push({ commits: [REVIEW_COMMIT], total_commits_count: 1 }));
    const reviews = only(evs, 'delivery.review.recorded');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      type: 'delivery.review.recorded',
      status: 'info',
      payload: {
        lane_key: 'agentic-delivery/prerequisites',
        verdict: 'accept',
        reviewer: 'agent:vitana-lane-reviewer (claude-sonnet-5.5)',
        reviewer_model: 'claude-sonnet-5.5',
        reviewed_head: REVIEWED,
        commit_sha: REVIEW_COMMIT.id,
        session: 'agent-vitana-lane-reviewer-202611051200-abcd',
        branch: 'kiro/agentic-delivery/gateway-delivery',
      },
    });
    expect(reviews[0].payload.dedupe_key).toBe(`gitlab:vitana/vitana-platform:review:${REVIEW_COMMIT.id}`);
  });

  it('a verdict other than accept or changes, or a reviewed head that is not 40 hex, is not trusted', async () => {
    const odd = { ...REVIEW_COMMIT, message: REVIEW_COMMIT.message.replace('Collab-Verdict: accept', 'Collab-Verdict: maybe') };
    expect(only(await events(push({ commits: [odd] })), 'delivery.review.recorded')).toHaveLength(0);
    const badHead = { ...REVIEW_COMMIT, message: REVIEW_COMMIT.message.replace(REVIEWED, 'not-a-sha') };
    expect(only(await events(push({ commits: [badHead] })), 'delivery.review.recorded')[0].payload.reviewed_head).toBeNull();
  });

  it('a pushed commit that changes a lane file gives one delivery.lane.updated per lane file', async () => {
    const commit = {
      id: '8888888888888888888888888888888888888888',
      title: 'lane(agentic-delivery/prerequisites): ready → executing',
      message: 'lane(...)\n\nCollab-Session: kiro-exafy-2\nCollab-Lane: agentic-delivery/prerequisites',
      added: ['.kiro/specs/agentic-delivery/lanes/new-lane.md'],
      modified: ['.kiro/specs/agentic-delivery/lanes/prerequisites.md', '.kiro/specs/agentic-delivery/tasks.md', 'services/gateway/src/x.ts', 'docs/specs/other/lanes/not-ours.md', '.kiro/specs/agentic-delivery/lanes/sub/dir.md'],
      removed: ['.kiro/specs/old-plan/lanes/_plan.md'],
    };
    const evs = await events(push({ commits: [commit] }));
    const lanes = only(evs, 'delivery.lane.updated');
    expect(lanes.map((e) => [e.payload.lane_key, e.payload.change])).toEqual([
      ['agentic-delivery/new-lane', 'added'],
      ['agentic-delivery/prerequisites', 'modified'],
      ['old-plan/_plan', 'removed'],
    ]);
    expect(lanes[0].payload).toMatchObject({ slug: 'agentic-delivery', lane: 'new-lane', commit_sha: commit.id, session: 'kiro-exafy-2' });
    expect(lanes[1].payload.dedupe_key).toBe(`gitlab:vitana/vitana-platform:lane:${commit.id}:agentic-delivery/prerequisites`);
  });

  it('a review entry commit gives the push, one review and one lane update', async () => {
    const evs = await events(push({ commits: [REVIEW_COMMIT] }));
    expect(topics(evs)).toEqual(['scm.gitlab.push', 'delivery.review.recorded', 'delivery.lane.updated']);
  });

  it('pushes to other branches, to refs that are not branches, and a deleted branch are ignored', async () => {
    for (const ref of ['refs/heads/main', 'refs/heads/feature/x', 'refs/heads/train/3', 'refs/tags/kiro/x', 'kiro/x', undefined]) {
      expect(await map(push({ ref }))).toEqual({ kind: 'ignore', reason: 'unmapped_ref' });
    }
    expect(await map(push({ after: '0'.repeat(40), commits: [] }))).toEqual({ kind: 'ignore', reason: 'unmapped_action' });
  });

  it('the agent branches are kiro, claude, assist and pm-agent', () => {
    for (const b of ['kiro/a/b', 'claude/x', 'assist/y', 'pm-agent/z']) expect(AGENT_BRANCH_RE.test(b)).toBe(true);
    for (const b of ['main', 'kirox/a', 'feature/kiro/a', 'train/1']) expect(AGENT_BRANCH_RE.test(b)).toBe(false);
  });

  it('looks at no more than 20 commits and 100 events of one push', async () => {
    const commits = Array.from({ length: 60 }, (_v, i) => ({ ...REVIEW_COMMIT, id: String(i).padStart(40, '0') }));
    const evs = await events(push({ commits, total_commits_count: 60 }));
    expect(only(evs, 'delivery.review.recorded')).toHaveLength(20);
    expect(evs.length).toBeLessThanOrEqual(100);
    expect(evs[0].payload.commits).toBe(60);
  });
});

describe('VTID-05547 shadow — a run is marked, and writes no deploy and no landing', () => {
  it('a run is shadow unless this gateway delivers the repository on GitLab', async () => {
    expect((await events(pipeline('success'), UNSET_ENV))[0].payload.mode).toBe('shadow');
    expect((await events(pipeline('success'), { DELIVERY_HOST_VITANA_V1: 'gitlab' }))[0].payload.mode).toBe('shadow'); // the other repository's flag
    expect((await events(pipeline('success'), { DELIVERY_HOST_VITANA_PLATFORM: 'github' }))[0].payload.mode).toBe('shadow');
    expect((await events(pipeline('success'), LIVE_ENV))[0].payload.mode).toBe('live');
    expect((await events(pipeline('success', { project: V1 }), { DELIVERY_HOST_VITANA_V1: 'gitlab' }))[0].payload.mode).toBe('live');
  });

  it('DELIVERY_MODE=shadow in the pipeline variables makes the run shadow even when the flag is set; other values change nothing', async () => {
    const shadow = pipeline('success', { attrs: { variables: [{ key: 'X', value: '1' }, { key: 'DELIVERY_MODE', value: 'Shadow' }] } });
    expect((await events(shadow, LIVE_ENV))[0].payload.mode).toBe('shadow');
    const liveVar = pipeline('success', { attrs: { variables: [{ key: 'DELIVERY_MODE', value: 'live' }] } });
    expect((await events(liveVar, UNSET_ENV))[0].payload.mode).toBe('shadow'); // a pipeline cannot make itself live
    expect((await events(liveVar, LIVE_ENV))[0].payload.mode).toBe('live');
  });

  it('a shadow run writes no staging.deploy.* and no delivery.landed, but its pipeline row is marked shadow', async () => {
    const evs = await events(pipeline('success', { builds: DEPLOY_BUILDS('success', 'success') }), UNSET_ENV);
    expect(topics(evs)).toEqual(['scm.gitlab.pipeline.succeeded']);
    expect(evs[0].payload.mode).toBe('shadow');
  });

  it('a project that is not one of the two repositories (a rehearsal) is always shadow', async () => {
    const env = { ...LIVE_ENV, DELIVERY_HOST_REHEARSAL: 'gitlab' } as NodeJS.ProcessEnv;
    const evs = await events(pipeline('success', { project: REHEARSAL, builds: DEPLOY_BUILDS('success') }), env);
    expect(topics(evs)).toEqual(['scm.gitlab.pipeline.succeeded']);
    expect(evs[0].payload).toMatchObject({ mode: 'shadow', repo: 'rehearsal' });
    expect(modeFor({ repo: 'rehearsal', env })).toBe('shadow');
  });

  it('pushes, merge requests and tags carry the mode too', async () => {
    expect((await events(push(), UNSET_ENV))[0].payload.mode).toBe('shadow');
    expect((await events(push(), LIVE_ENV))[0].payload.mode).toBe('live');
    expect((await events(mergeRequest('open'), UNSET_ENV))[0].payload.mode).toBe('shadow');
    expect((await events(tagPush('refs/tags/delivery/cutover-vitana-v1'), UNSET_ENV))[0].payload.mode).toBe('shadow');
  });
});

describe('VTID-05547 every event — shape, privacy, bounds', () => {
  const corpus = (): Array<[string, unknown]> => [
    ['mr open', mergeRequest('open', { description: 'Moved from https://github.com/exafyltd/vitana-platform/pull/9' })],
    ['mr merge', mergeRequest('merge')],
    ['mr close', mergeRequest('close')],
    ['mr update', mergeRequest('update', {}, { changes: { labels: { previous: [], current: [{ title: 'queue-ready' }] } }, labels: [{ title: 'queue-ready' }] })],
    ['pipeline running main', pipeline('running')],
    ['pipeline success main', pipeline('success', { builds: DEPLOY_BUILDS('success', 'success') })],
    ['pipeline failed main', pipeline('failed', { builds: DEPLOY_BUILDS('failed') })],
    ['pipeline canceled', pipeline('canceled', { attrs: { ref: 'b' }, merge_request: { iid: 12, title: LANE_TITLE } })],
    ['pipeline nightly', pipeline('failed', { attrs: { source: 'schedule' }, commit: { id: 'x', title: 'chore', message: 'chore' } })],
    ['push review', push({ commits: [REVIEW_COMMIT, ...(push().commits as unknown[])] })],
    ['tag', tagPush('refs/tags/delivery/cutover-vitana-platform')],
  ];

  it('every event has a VTID or BOOTSTRAP-DELIVERY, metadata.dedupe_key, plane delivery, host gitlab and a mode', async () => {
    let total = 0;
    for (const [name, payload] of corpus()) {
      const evs = await events(payload);
      const keys = new Set<string>();
      for (const e of evs) {
        total++;
        expect({ name, vtid: /^(VTID-\d{5}|BOOTSTRAP-DELIVERY)$/.test(e.vtid) }).toEqual({ name, vtid: true });
        expect(typeof e.payload.dedupe_key).toBe('string');
        expect(e.payload.dedupe_key.startsWith('gitlab:')).toBe(true);
        expect(e.payload).toMatchObject({ plane: 'delivery', host: 'gitlab' });
        expect(['shadow', 'live']).toContain(e.payload.mode);
        expect(e.source).toBe('gitlab-webhook');
        expect(['info', 'success', 'warning', 'error']).toContain(e.status);
        expect(typeof e.message).toBe('string');
        keys.add(e.payload.dedupe_key);
      }
      expect({ name, distinctKeys: keys.size }).toEqual({ name, distinctKeys: evs.length }); // no two events of one delivery share a key
    }
    expect(total).toBeGreaterThanOrEqual(20);
  });

  it('the dedupe key is stable for the same fact and differs for a different state', async () => {
    const a = (await events(pipeline('success', { attrs: { ref: 'b' }, merge_request: { iid: 1, title: LANE_TITLE } })))[0].payload.dedupe_key;
    const b = (await events(pipeline('success', { attrs: { ref: 'b' }, merge_request: { iid: 1, title: LANE_TITLE } }), LIVE_ENV, {}))[0].payload.dedupe_key;
    const failed = (await events(pipeline('failed', { attrs: { ref: 'b' }, merge_request: { iid: 1, title: LANE_TITLE } })))[0].payload.dedupe_key;
    const other = (await events(pipeline('success', { attrs: { id: 32, ref: 'b' }, merge_request: { iid: 1, title: LANE_TITLE } })))[0].payload.dedupe_key;
    expect(a).toBe(b);
    expect(new Set([a, failed, other]).size).toBe(3);
    const reopened = (await events(mergeRequest('reopen', { updated_at: '2026-11-05 11:00:00 UTC' })))[0].payload.dedupe_key;
    const opened = (await events(mergeRequest('open')))[0].payload.dedupe_key;
    expect(reopened).not.toBe(opened);
  });

  it('never carries the description, the user, labels other than the queue label, the changes, pipeline variables or raw builds', async () => {
    for (const [name, payload] of corpus()) {
      const text = JSON.stringify(await events(payload));
      for (const leak of ['secret-description-text', 'agent@example.invalid', 'Agent Kiro', 'agent-kiro-exafy', 'secret-label', 'SECRET_VARIABLE', 'secret-variable-value', 'secret-user', 'user_name']) {
        expect({ name, leak, found: text.includes(leak) }).toEqual({ name, leak, found: false });
      }
    }
  });

  it('long strings are cut to 512 characters and odd fields become null', async () => {
    const evs = await events(mergeRequest('update', { source_branch: 'b'.repeat(2000), url: { nested: true }, last_commit: null, iid: 'x' }, { changes: { labels: { previous: [], current: [{ title: 'queue-ready' }] } } }));
    expect((evs[0].payload.source_branch as string).length).toBe(512);
    expect(evs[0].payload).toMatchObject({ url: null, head_sha: null, merge_request_iid: null });
    const longId = await mapGitlabDelivery(pipeline('running'), 'w'.repeat(900), { env: LIVE_ENV, branches: new MemoryBranchVtidIndex() });
    if (longId.kind !== 'emit') throw new Error('expected emit');
    expect((longId.events[0].payload.webhook_id as string).length).toBe(512);
  });

  it('an unknown event, hostile payloads and non-objects are ignored and never throw', async () => {
    for (const payload of [null, undefined, 3, 'merge_request', [mergeRequest('open')], {}, { object_kind: 'note' }, { object_kind: 'build' }, { object_kind: 'merge_request' }, { object_kind: 'pipeline', object_attributes: 'x' }, { object_kind: 'push', ref: 5 }, { object_kind: 'tag_push' }]) {
      const m = await map(payload);
      expect(m.kind).toBe('ignore');
    }
    const hostile = { object_kind: 'pipeline', object_attributes: { status: 'success', ref: 'main', variables: 'x', id: 'x' }, builds: [null, 'x', { name: {} }], commit: 'x', project: [], merge_request: 5 };
    await expect(map(hostile)).resolves.toBeDefined();
    const proto = JSON.parse('{"object_kind":"pipeline","object_attributes":{"status":"__proto__"}}');
    expect(await map(proto)).toEqual({ kind: 'ignore', reason: 'unmapped_status' });
  });

  it('an unknown project still maps, under an unknown-project scope', async () => {
    const evs = await events(pipeline('running', { project: {} as never }));
    expect(evs[0].payload.dedupe_key).toBe('gitlab:unknown-project:pipeline:31:running');
    expect(evs[0].message).toBe('GitLab pipeline 31 started on main in an unknown project');
  });
});

describe('VTID-05547 no delivery event can move a VTID', () => {
  const STATES: AutopilotState[] = ['allocated', 'scheduled', 'in_progress', 'building', 'pr_created', 'reviewing', 'validated', 'merged', 'deploying', 'verifying', 'completed', 'failed'];
  const NEW_TOPICS = Object.values(DELIVERY_TOPICS);

  it('no rule of autopilot-event-mapper.ts lists a scm.gitlab.*, scm.migration.* or delivery.* topic, or staging.deploy.rolled_back', () => {
    const listed = EVENT_MAPPING_RULES.flatMap((r) => r.eventTypes);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((t) => /^(scm\.gitlab\.|scm\.migration\.|delivery\.)/.test(t) || t === 'staging.deploy.rolled_back')).toEqual([]);
    expect(listed.filter((t) => NEW_TOPICS.includes(t as never))).toEqual([]);
  });

  it('none of the events of the corpus, with the status given, matches a rule in any state', async () => {
    const payloads = [
      mergeRequest('open'), mergeRequest('merge'), mergeRequest('close'),
      mergeRequest('update', {}, { changes: { labels: { previous: [], current: [{ title: 'queue-ready' }] } } }),
      pipeline('running'), pipeline('success', { builds: DEPLOY_BUILDS('success', 'success') }), pipeline('failed', { builds: DEPLOY_BUILDS('failed') }), pipeline('canceled'),
      push({ commits: [REVIEW_COMMIT] }), tagPush('refs/tags/delivery/cutover-vitana-v1'),
      mergeRequest('open', { description: 'Moved from https://github.com/exafyltd/vitana-v1/pull/7' }),
    ];
    const seen = new Set<string>();
    for (const p of payloads) {
      for (const e of await events(p)) {
        seen.add(e.type);
        for (const state of STATES) {
          const r = mapEventToTransition({ id: 'x', created_at: '2026-11-05T00:00:00Z', vtid: e.vtid, topic: e.type, status: e.status, task_stage: e.task_stage }, state);
          expect({ topic: e.type, state, matched: r.matched }).toEqual({ topic: e.type, state, matched: false });
        }
      }
    }
    // The corpus reached every topic this layer writes: its own, and the three merge request topics it keeps from mapper.ts
    // (the refusal event is the guard's, not this layer's).
    const kept = ['scm.gitlab.merge_request.opened', 'scm.gitlab.merge_request.merged', 'scm.gitlab.merge_request.closed'];
    expect([...seen].sort()).toEqual([...NEW_TOPICS, ...kept].sort());
  });

  it('no topic ending in .failed or .error is written with status error', async () => {
    for (const [, payload] of [['f', pipeline('failed', { builds: DEPLOY_BUILDS('failed') })], ['n', pipeline('failed', { attrs: { source: 'schedule' }, commit: { id: 'x', title: 'chore', message: 'chore' } })]] as Array<[string, unknown]>) {
      for (const e of await events(payload)) {
        if (/\.(failed|error)$/.test(e.type)) expect(e.status).not.toBe('error');
      }
    }
  });

  it('the merge request topics carry the VALIDATOR stage, so the word "merge" does not infer the Deploy stage', async () => {
    for (const p of [mergeRequest('open'), mergeRequest('merge'), mergeRequest('update', {}, { changes: { labels: { previous: [], current: [{ title: 'queue-ready' }] } } })]) {
      const e = (await events(p))[0];
      expect(e.type).toContain('merge_request');
      expect(e.task_stage).toBe('VALIDATOR');
    }
  });
});

describe('VTID-05547 topics — members of CicdEventType, and mapper.ts kept as it is', () => {
  it('every topic this layer writes is a literal of the CicdEventType union in types/cicd.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'types', 'cicd.ts'), 'utf8');
    const start = src.indexOf('export type CicdEventType =');
    expect(start).toBeGreaterThan(-1);
    const code: string[] = [];
    for (const line of src.slice(start).split('\n')) {
      const c = line.replace(/\/\/.*$/, '');
      code.push(c);
      if (/;\s*$/.test(c)) break;
    }
    const union = code.join('\n');
    expect((union.match(/\| '/g) || []).length).toBeGreaterThan(100);
    for (const t of [...Object.values(DELIVERY_TOPICS), 'delivery.merge.refused']) expect(union).toContain(`| '${t}'`);
    // The five topics of VTID-05541 are there once, not duplicated by this lane.
    for (const t of ['scm.gitlab.merge_request.opened', 'scm.gitlab.merge_request.merged', 'scm.gitlab.merge_request.closed']) {
      expect(union.split(`| '${t}'`)).toHaveLength(2);
    }
  });

  it('the events of mapper.ts are kept as they are: the delivery fields are added, nothing is changed or removed', async () => {
    const cases: Array<[unknown, number]> = [[mergeRequest('merge'), 0], [mergeRequest('open'), 0], [mergeRequest('close'), 0], [pipeline('success', { attrs: { ref: 'b' }, merge_request: { iid: 12, title: LANE_TITLE } }), 0], [pipeline('failed', { attrs: { ref: 'b' }, merge_request: { iid: 12, title: LANE_TITLE } }), 0]];
    for (const [payload, at] of cases) {
      const m2 = mapGitlabEvent(payload, 'wh_1');
      if (m2.kind !== 'emit') throw new Error('expected the base mapper to emit');
      const mine = (await events(payload))[at];
      const { repo, plane, host, mode, dedupe_key, lane_key, queue_label, jobs, queued_s, tag, ...rest } = mine.payload as Record<string, unknown>;
      expect([repo, plane, host, mode, typeof dedupe_key]).toEqual(['vitana-platform', 'delivery', 'gitlab', 'live', 'string']);
      expect({ ...mine, payload: rest }).toEqual(m2.event);
    }
  });

  it('the pipeline event built for a delivery with no VTID has the shape mapper.ts gives one with a VTID', async () => {
    const withVtid = pipeline('failed', { attrs: { ref: 'b' }, merge_request: { iid: 12, title: LANE_TITLE } });
    const without = pipeline('failed', { attrs: { ref: 'b' }, merge_request: { iid: 12, title: 'no ticket' }, commit: { id: 'x', title: 'chore', message: '' } });
    const m2 = mapGitlabEvent(withVtid, 'wh_1');
    if (m2.kind !== 'emit') throw new Error('expected emit');
    const built = (await events(without))[0];
    expect(built.vtid).toBe('BOOTSTRAP-DELIVERY');
    const { repo, plane, host, mode, dedupe_key, lane_key, queue_label, jobs, queued_s, tag, ...rest } = built.payload as Record<string, unknown>;
    expect({ ...built, vtid: m2.event.vtid, payload: rest }).toEqual(m2.event);
  });
});

describe('VTID-05547 helpers', () => {
  it('parseTrailers takes the last whole-line "Key: value" for each wanted key and nothing else', () => {
    const t = parseTrailers('subject\n\nReviewer: first\nNote: Reviewer: embedded\nReviewer: second\n  Merge-Request: indented\nMerge-Request:    !9  \n', ['Reviewer', 'Merge-Request', 'Absent']);
    expect(t).toEqual({ Reviewer: 'second', 'Merge-Request': '!9', Absent: null });
    expect(parseTrailers(undefined, ['A'])).toEqual({ A: null });
    expect(parseTrailers('A: ' + 'x'.repeat(2000), ['A']).A).toHaveLength(512);
  });

  it('queueLabel finds the queue-* label among objects or strings, and only those', () => {
    expect(queueLabel([{ title: 'bug' }, { title: 'queue-blocked' }])).toBe('queue-blocked');
    expect(queueLabel(['queue-paused'])).toBe('queue-paused');
    expect(queueLabel([{ title: 'queue-other' }, { title: 'queue-' }, { title: 'x-queue-ready' }, 4, null])).toBeNull();
    expect(queueLabel(undefined)).toBeNull();
  });

  it('laneKeyOf reads the lane from a title with a VTID and nothing else', () => {
    expect(laneKeyOf(LANE_TITLE)).toBe('agentic-delivery/gateway-delivery');
    expect(laneKeyOf('VTID-05547 (agentic-delivery/_plan): x')).toBe('agentic-delivery/_plan');
    expect(laneKeyOf('plan(agentic-delivery): x')).toBeNull();
    expect(laneKeyOf('(a/b) without a VTID')).toBeNull();
    expect(laneKeyOf(7)).toBeNull();
  });

  it('the branch index keeps the newest entries and drops the oldest first', () => {
    const idx = new MemoryBranchVtidIndex(2);
    idx.remember('p', 'a', 'VTID-00001');
    idx.remember('p', 'b', 'VTID-00002');
    idx.remember('p', 'a', 'VTID-00003'); // a is newest again
    idx.remember('p', 'c', 'VTID-00004'); // drops b
    expect([idx.get('p', 'a'), idx.get('p', 'b'), idx.get('p', 'c'), idx.get('q', 'a')]).toEqual(['VTID-00003', null, 'VTID-00004', null]);
    expect(idx.size()).toBe(2);
  });

  it('a merge request event teaches the index its branch, and only with a VTID in the title', async () => {
    const idx = new MemoryBranchVtidIndex();
    await mapGitlabDelivery(mergeRequest('open'), 'w', { env: LIVE_ENV, branches: idx });
    expect(idx.get('vitana/vitana-platform', 'kiro/agentic-delivery/gateway-delivery')).toBe('VTID-05547');
    const idx2 = new MemoryBranchVtidIndex();
    await mapGitlabDelivery(mergeRequest('open', { title: 'no ticket' }), 'w', { env: LIVE_ENV, branches: idx2 });
    expect(idx2.size()).toBe(0);
  });
});
