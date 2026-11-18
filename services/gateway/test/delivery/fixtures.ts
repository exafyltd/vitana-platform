/**
 * VTID-05547: GitLab payload and OASIS row builders shared by the test/delivery suites. Not a test file
 * (the Jest pattern is *.test.ts). Nothing here calls a network; every value is invented.
 */
import { createHmac } from 'crypto';
import type { EventRow } from '../../src/services/gitlab-events/delivery-summary';

export const LIVE_ENV = { DELIVERY_HOST_VITANA_PLATFORM: 'gitlab', DELIVERY_HOST_VITANA_V1: 'gitlab' } as NodeJS.ProcessEnv;
export const UNSET_ENV = {} as NodeJS.ProcessEnv;

export const PLATFORM = { id: 42, path_with_namespace: 'vitana/vitana-platform', web_url: 'https://gitlab.example.invalid/vitana/vitana-platform' };
export const V1 = { id: 43, path_with_namespace: 'vitana/vitana-v1', web_url: 'https://gitlab.example.invalid/vitana/vitana-v1' };
export const REHEARSAL = { id: 44, path_with_namespace: 'vitana/rehearsal' };

export const LANE_TITLE = 'VTID-05547 (agentic-delivery/gateway-delivery): gateway side of delivery';
export const HEAD = 'abc0000000000000000000000000000000000002';
export const MERGE_SHA = 'c0ffee0000000000000000000000000000000001';
export const REVIEWED = '0123456789abcdef0123456789abcdef01234567';

export const LANDING_MESSAGE = [
  LANE_TITLE,
  '',
  'Squash of the lane.',
  '',
  'Merge-Request: !12',
  'Source-Branch: kiro/agentic-delivery/gateway-delivery',
  `Reviewed-Head: ${REVIEWED}`,
  'Review-Verdict: accept',
  'Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)',
  'Accepted-At: 2026-11-05T10:00:00Z',
].join('\n');

export function mergeRequest(action: string, over: Record<string, unknown> = {}, top: Record<string, unknown> = {}, project = PLATFORM) {
  return {
    object_kind: 'merge_request',
    user: { id: 7, name: 'Agent Kiro', username: 'agent-kiro-exafy', email: 'agent@example.invalid' },
    project,
    object_attributes: {
      id: 9001,
      iid: 12,
      title: LANE_TITLE,
      description: 'secret-description-text that must never reach OASIS',
      state: action === 'merge' ? 'merged' : action === 'close' ? 'closed' : 'opened',
      action,
      source_branch: 'kiro/agentic-delivery/gateway-delivery',
      target_branch: 'main',
      merge_commit_sha: action === 'merge' ? MERGE_SHA : null,
      url: `${project.web_url ?? 'https://gitlab.example.invalid/x'}/-/merge_requests/12`,
      updated_at: '2026-11-05 10:00:00 UTC',
      last_commit: { id: HEAD, title: 'head' },
      ...over,
    },
    labels: [{ title: 'secret-label' }],
    ...top,
  };
}

export function pipeline(status: string, over: { attrs?: Record<string, unknown>; commit?: Record<string, unknown> | null; merge_request?: unknown; builds?: unknown; project?: Record<string, unknown> } = {}) {
  return {
    object_kind: 'pipeline',
    object_attributes: {
      id: 31,
      iid: 3,
      ref: 'main',
      tag: false,
      sha: MERGE_SHA,
      source: 'push',
      status,
      duration: 63,
      queued_duration: 4,
      url: 'https://gitlab.example.invalid/vitana/vitana-platform/-/pipelines/31',
      variables: [{ key: 'SECRET_VARIABLE', value: 'secret-variable-value' }],
      ...(over.attrs || {}),
    },
    merge_request: 'merge_request' in over ? over.merge_request : null,
    user: { id: 7, name: 'Agent Kiro', username: 'agent-kiro-exafy', email: 'agent@example.invalid' },
    project: over.project ?? PLATFORM,
    commit:
      'commit' in over
        ? over.commit
        : { id: MERGE_SHA, title: LANE_TITLE, message: LANDING_MESSAGE, timestamp: '2026-11-05T10:05:30+00:00' },
    builds: 'builds' in over ? over.builds : [{ id: 1, name: 'test', stage: 'test', status, duration: 30.5, queued_duration: 2.25, user: { name: 'secret-user' } }],
  };
}

export function push(over: Record<string, unknown> = {}, project = PLATFORM) {
  return {
    object_kind: 'push',
    event_name: 'push',
    before: '1111111111111111111111111111111111111111',
    after: HEAD,
    ref: 'refs/heads/kiro/agentic-delivery/gateway-delivery',
    checkout_sha: HEAD,
    user_name: 'secret-user-name',
    project,
    total_commits_count: 1,
    commits: [
      {
        id: HEAD,
        title: `${LANE_TITLE}`,
        message: `${LANE_TITLE}\n\nCollab-Session: kiro-exafy-202611021438-cff7\nCollab-Lane: agentic-delivery/gateway-delivery\n`,
        timestamp: '2026-11-05T10:00:00+00:00',
        added: [],
        modified: ['services/gateway/src/routes/delivery.ts'],
        removed: [],
      },
    ],
    ...over,
  };
}

export const REVIEW_COMMIT = {
  id: '9999999999999999999999999999999999999999',
  title: 'review(agentic-delivery/prerequisites): accept',
  message: [
    'review(agentic-delivery/prerequisites): accept',
    '',
    'Collab-Session: agent-vitana-lane-reviewer-202611051200-abcd',
    'Collab-Review: agentic-delivery/prerequisites',
    'Collab-Verdict: accept',
    'Collab-Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)',
    `Collab-Reviewed-Head: ${REVIEWED}`,
  ].join('\n'),
  added: [],
  modified: ['.kiro/specs/agentic-delivery/lanes/prerequisites.md'],
  removed: [],
};

export function tagPush(ref: string, over: Record<string, unknown> = {}, project = PLATFORM) {
  return { object_kind: 'tag_push', ref, checkout_sha: MERGE_SHA, after: MERGE_SHA, project, ...over };
}

// ---- the signed request the way GitLab sends it (Standard Webhooks) -------------------------------------

export const SIGNING_KEY = `whsec_${Buffer.from('vitana-gitlab-delivery-test-key-0123456789').toString('base64')}`;

export function signedHeaders(raw: string, id: string, key = SIGNING_KEY, ts = String(Math.floor(Date.now() / 1000))) {
  const k = Buffer.from(key.slice('whsec_'.length), 'base64');
  const sig = createHmac('sha256', k).update(`${id}.${ts}.${raw}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` };
}

// ---- OASIS rows as the Delivery routes read them -----------------------------------------------------------

let rowSeq = 0;
export function row(topic: string, createdAt: string, metadata: Record<string, unknown>, extra: Partial<EventRow> = {}): EventRow {
  rowSeq += 1;
  return { id: `row-${rowSeq}`, created_at: createdAt, vtid: 'VTID-05547', topic, status: 'info', message: topic, service: 'gitlab-webhook', metadata, ...extra };
}

export const base = (over: Record<string, unknown>) => ({ plane: 'delivery', host: 'gitlab', mode: 'live', repo: 'vitana-platform', ...over });
