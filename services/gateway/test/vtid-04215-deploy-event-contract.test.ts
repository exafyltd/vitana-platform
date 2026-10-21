/**
 * VTID-04215: the Dev Autopilot deploy watcher / reconciler must recognise
 * the topics the AWS deploy workflows actually write.
 *
 * Until this VTID both consumers queried only the GCP-era
 * `deploy.gateway.success` family; `AWS-STAGE-DEPLOY-GATEWAY.yml` writes
 * `staging.deploy.completed`, so every auto-merged execution timed out in
 * `deploying` and was reverted from main. These tests pin the contract from
 * both ends: the workflow files' own topic strings, and the consumers'
 * matching logic.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  AWS_DEPLOY_TOPICS,
  LEGACY_DEPLOY_SUCCESS_TOPICS,
  deployTopicsForEnv,
  deployTopicsInFilter,
  normalizeDeployEvent,
  resolveDeployOutcome,
} from '../src/services/dev-autopilot-deploy-topics';
import { findDeployOutcomeForExecution } from '../src/services/dev-autopilot-watcher';

const WORKFLOWS = path.resolve(__dirname, '../../../.github/workflows');
const MERGE_SHA = 'afa9998b53c5183de7da1bbed5aa9f7c53bb2dea';
const LATER_SHA = '91d8dfc32e4ba9e1cbaecb7c3e02c0d1b984c88e';
const nowIso = () => new Date().toISOString();
const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A row exactly as the staging workflow's `Emit OASIS event` step inserts it. */
function stagingRow(status: 'success' | 'error', sha: string, createdAt = nowIso()) {
  const t = AWS_DEPLOY_TOPICS.staging;
  return {
    id: `evt-${sha.slice(0, 6)}-${status}`,
    topic: status === 'success' ? t.success : t.failure,
    status,
    created_at: createdAt,
    metadata: { env: 'staging', platform: 'aws-ecs', git_commit: sha, workflow: t.workflow },
  };
}

describe('VTID-04215: workflow topic strings match the consumer contract (drift pin)', () => {
  it.each([
    ['staging', 'AWS-STAGE-DEPLOY-GATEWAY.yml'],
    ['production', 'AWS-PROD-DEPLOY-GATEWAY.yml'],
  ] as const)('%s workflow emits exactly the success/failure topics this module names', (env, file) => {
    const yml = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
    const t = AWS_DEPLOY_TOPICS[env];
    expect(t.workflow).toBe(file);
    const topicLine = yml.split('\n').find((l) => /TOPIC=\$\(\[/.test(l));
    expect(topicLine).toBeDefined();
    expect(topicLine).toContain(`echo ${t.success}`);
    expect(topicLine).toContain(`echo ${t.failure}`);
    // The row is written to oasis_events with metadata.git_commit — the key
    // the consumers match on.
    expect(yml).toMatch(/rest\/v1\/oasis_events/);
    expect(yml).toMatch(/git_commit:\s*\$sha/);
  });
});

describe('VTID-04215: deployTopicsForEnv', () => {
  it('staging queries its own AWS topics plus legacy, never the prod topics', () => {
    const topics = deployTopicsForEnv('staging');
    expect(topics).toContain('staging.deploy.completed');
    expect(topics).toContain('staging.deploy.failed');
    expect(topics).not.toContain('prod.deploy.completed');
    for (const legacy of LEGACY_DEPLOY_SUCCESS_TOPICS) expect(topics).toContain(legacy);
    expect(deployTopicsInFilter('staging')).toBe(`in.(${topics.join(',')})`);
  });

  it('production (or unset) queries the prod topics, never staging', () => {
    for (const env of ['production', undefined, 'anything-else']) {
      const topics = deployTopicsForEnv(env);
      expect(topics).toContain('prod.deploy.completed');
      expect(topics).toContain('prod.deploy.failed');
      expect(topics).not.toContain('staging.deploy.completed');
    }
  });
});

describe('VTID-04215: normalizeDeployEvent', () => {
  it('maps staging.deploy.completed onto deploy.gateway.success with branch main and git_commit kept', () => {
    const n = normalizeDeployEvent(stagingRow('success', MERGE_SHA));
    expect(n.type).toBe('deploy.gateway.success');
    expect(n.payload.git_commit).toBe(MERGE_SHA);
    expect(n.payload.branch).toBe('main');
    expect(n.payload.env).toBe('staging');
    expect(n.topic).toBe('staging.deploy.completed');
  });

  it('maps staging.deploy.failed onto deploy.gateway.failed', () => {
    expect(normalizeDeployEvent(stagingRow('error', MERGE_SHA)).type).toBe('deploy.gateway.failed');
  });

  it('maps the prod topics the same way', () => {
    const n = normalizeDeployEvent({ topic: 'prod.deploy.completed', metadata: { git_commit: MERGE_SHA } });
    expect(n.type).toBe('deploy.gateway.success');
    expect(n.payload.branch).toBe('main');
    expect(n.payload.env).toBe('production');
  });

  it('passes a legacy topic through unchanged, payload = metadata', () => {
    const n = normalizeDeployEvent({ topic: 'deploy.gateway.success', metadata: { branch: 'main', git_commit: 'x' }, status: 'success' });
    expect(n.type).toBe('deploy.gateway.success');
    expect(n.payload).toEqual({ branch: 'main', git_commit: 'x' });
  });

  it('tolerates a null metadata column', () => {
    expect(normalizeDeployEvent({ topic: 'staging.deploy.completed', metadata: null }).payload.branch).toBe('main');
  });
});

describe('VTID-04215: the watcher recognises a normalized staging deploy', () => {
  const exec = {
    pr_url: 'https://github.com/exafyltd/vitana-platform/pull/9001',
    pr_number: 9001,
    branch: 'dev-autopilot/141c4e4b',
    updated_at: agoIso(10 * 60_000),
    metadata: { merge_sha: MERGE_SHA },
  };
  const asWatcherEvent = (row: ReturnType<typeof stagingRow>) => {
    const n = normalizeDeployEvent(row);
    return { type: n.type, payload: n.payload, created_at: n.created_at, status: n.status };
  };

  it('the exact reverted case: staging deploy of the merge SHA after the merge → success', () => {
    expect(findDeployOutcomeForExecution([asWatcherEvent(stagingRow('success', MERGE_SHA))], exec)).toBe('success');
  });

  it('queued-merge fallback: a later main deploy of a different SHA → success', () => {
    expect(findDeployOutcomeForExecution([asWatcherEvent(stagingRow('success', LATER_SHA))], exec)).toBe('success');
  });

  it('a failed staging deploy after the merge → failed', () => {
    expect(findDeployOutcomeForExecution([asWatcherEvent(stagingRow('error', LATER_SHA))], exec)).toBe('failed');
  });

  it('a deploy from before the merge does not count', () => {
    expect(findDeployOutcomeForExecution([asWatcherEvent(stagingRow('success', MERGE_SHA, agoIso(60 * 60_000)))], exec)).toBe('pending');
  });

  it('the raw (un-normalized) staging row would still be ignored — normalization is load-bearing', () => {
    const raw = stagingRow('success', MERGE_SHA);
    expect(findDeployOutcomeForExecution([{ type: raw.topic, payload: raw.metadata, created_at: raw.created_at, status: raw.status }], exec)).toBe('pending');
  });
});

describe('VTID-04215: resolveDeployOutcome (the reconciler decision)', () => {
  const since = agoIso(10 * 60_000);
  const ev = (row: ReturnType<typeof stagingRow>) => normalizeDeployEvent(row);

  it('exact merge_sha match wins and is reported as such', () => {
    const r = resolveDeployOutcome([ev(stagingRow('success', LATER_SHA)), ev(stagingRow('success', MERGE_SHA))], { mergeSha: MERGE_SHA, sinceIso: since });
    expect(r.outcome).toBe('success');
    expect(r.matched_by).toBe('merge_sha');
    expect(r.matched?.payload.git_commit).toBe(MERGE_SHA);
  });

  it('falls back to a later successful main deploy when the exact SHA never deployed (concurrency-cancelled run)', () => {
    const r = resolveDeployOutcome([ev(stagingRow('success', LATER_SHA))], { mergeSha: MERGE_SHA, sinceIso: since });
    expect(r.outcome).toBe('success');
    expect(r.matched_by).toBe('post_merge_main');
  });

  it('a failed main deploy after the merge beats a success (conservative)', () => {
    const r = resolveDeployOutcome([ev(stagingRow('success', LATER_SHA)), ev(stagingRow('error', LATER_SHA))], { mergeSha: MERGE_SHA, sinceIso: since });
    expect(r.outcome).toBe('failed');
  });

  it('events before the watermark are ignored → pending', () => {
    const r = resolveDeployOutcome([ev(stagingRow('success', MERGE_SHA, agoIso(60 * 60_000)))], { mergeSha: MERGE_SHA, sinceIso: since });
    expect(r.outcome).toBe('pending');
  });

  it('no events at all → pending (the reconciler then fails the row as before)', () => {
    expect(resolveDeployOutcome([], { mergeSha: MERGE_SHA, sinceIso: since }).outcome).toBe('pending');
  });

  it('a row without merge_sha keeps the original recency behaviour', () => {
    const r = resolveDeployOutcome([ev(stagingRow('success', LATER_SHA))], { mergeSha: null, sinceIso: since });
    expect(r.outcome).toBe('success');
    expect(r.matched_by).toBe('recency');
  });
});
