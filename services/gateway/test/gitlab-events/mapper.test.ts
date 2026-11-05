/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5, tasks.md W1/W2/W6) — the GitLab event → OASIS mapper.
 *
 * Pins:
 *   1. The event-to-topic table of plan §3.5: merge_request open|reopen → opened, merge → merged,
 *      close → closed; pipeline success → succeeded, failed → failed. Everything else is ignored.
 *   2. The VTID: the first VTID-\d{5} of the merge request title (merge_request events), or of
 *      merge_request.title and then commit.title (pipeline events). None → ignored.
 *   3. The OASIS event carries only ids, refs, shas, statuses and URLs: never the description, the
 *      user, the labels or the pipeline variables of the GitLab payload.
 *   4. The five topics are members of the closed union CicdEventType (cicd.ts), and none is a cicd.* topic.
 *   5. W6: no rule of the VTID lifecycle mapper (autopilot-event-mapper.ts, not edited) lists a
 *      scm.gitlab.* topic, and none of the five events, with the status the route gives it, moves a
 *      VTID's state from any state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GITLAB_OASIS_TOPICS, GITLAB_EVENT_SOURCE, firstVtid, mapGitlabEvent } from '../../src/services/gitlab-events/mapper';
import { EVENT_MAPPING_RULES, mapEventToTransition } from '../../src/services/autopilot-event-mapper';
import type { AutopilotState } from '../../src/services/autopilot-controller';

const FIVE_TOPICS = [
  'scm.gitlab.merge_request.opened',
  'scm.gitlab.merge_request.merged',
  'scm.gitlab.merge_request.closed',
  'scm.gitlab.pipeline.succeeded',
  'scm.gitlab.pipeline.failed',
];

function mergeRequest(action: string, over: Record<string, unknown> = {}) {
  return {
    object_kind: 'merge_request',
    event_type: 'merge_request',
    user: { id: 7, name: 'Agent Kiro', username: 'agent-kiro-exafy', email: 'agent@example.invalid' },
    project: { id: 42, name: 'rehearsal', path_with_namespace: 'vitana/rehearsal', web_url: 'https://gitlab.vitanaland.com/vitana/rehearsal' },
    object_attributes: {
      id: 9001,
      iid: 12,
      title: 'VTID-05541 (eng-gitlab-m2/scm-webhook): GitLab webhook route',
      description: 'secret-description-text that must never reach OASIS',
      state: action === 'merge' ? 'merged' : action === 'close' ? 'closed' : 'opened',
      action,
      source_branch: 'kiro/eng-gitlab-m2/scm-webhook',
      target_branch: 'main',
      merge_commit_sha: action === 'merge' ? 'c0ffee0000000000000000000000000000000001' : null,
      url: 'https://gitlab.vitanaland.com/vitana/rehearsal/-/merge_requests/12',
      last_commit: { id: 'abc0000000000000000000000000000000000002', title: 'VTID-05541 head', message: 'VTID-05541 head\n' },
      ...over,
    },
    labels: [{ title: 'secret-label' }],
  };
}

function pipeline(status: string, over: { attrs?: Record<string, unknown>; merge_request?: unknown; commit?: unknown } = {}) {
  return {
    object_kind: 'pipeline',
    object_attributes: {
      id: 31,
      iid: 3,
      ref: 'kiro/eng-gitlab-m2/scm-webhook',
      tag: false,
      sha: 'abc0000000000000000000000000000000000002',
      source: 'merge_request_event',
      status,
      detailed_status: status,
      duration: 63,
      url: 'https://gitlab.vitanaland.com/vitana/rehearsal/-/pipelines/31',
      variables: [{ key: 'SECRET_VARIABLE', value: 'secret-variable-value' }],
      ...(over.attrs || {}),
    },
    merge_request: 'merge_request' in over ? over.merge_request : { id: 9001, iid: 12, title: 'VTID-05541 (eng-gitlab-m2/scm-webhook): GitLab webhook route', url: 'https://gitlab.vitanaland.com/vitana/rehearsal/-/merge_requests/12' },
    user: { id: 7, name: 'Agent Kiro', username: 'agent-kiro-exafy', email: 'agent@example.invalid' },
    project: { id: 42, path_with_namespace: 'vitana/rehearsal' },
    commit: 'commit' in over ? over.commit : { id: 'abc0000000000000000000000000000000000002', title: 'VTID-05999 commit title', message: 'body' },
    builds: [{ id: 1, name: 'test', status }],
  };
}

function emitted(m: ReturnType<typeof mapGitlabEvent>) {
  if (m.kind !== 'emit') throw new Error(`expected emit, got ${JSON.stringify(m)}`);
  return m.event;
}

describe('VTID-05541 mapper — the event-to-topic table of plan §3.5', () => {
  it.each([
    ['merge_request', 'open', 'scm.gitlab.merge_request.opened'],
    ['merge_request', 'reopen', 'scm.gitlab.merge_request.opened'],
    ['merge_request', 'merge', 'scm.gitlab.merge_request.merged'],
    ['merge_request', 'close', 'scm.gitlab.merge_request.closed'],
    ['pipeline', 'success', 'scm.gitlab.pipeline.succeeded'],
    ['pipeline', 'failed', 'scm.gitlab.pipeline.failed'],
  ])('%s %s → %s', (kind, value, topic) => {
    const payload = kind === 'merge_request' ? mergeRequest(value) : pipeline(value);
    const event = emitted(mapGitlabEvent(payload, 'msg_1'));
    expect(event.type).toBe(topic);
  });

  it.each(['update', 'approved', 'unapproved', 'approval', 'unapproval', '', undefined])(
    'merge_request action %p is acknowledged and ignored (unmapped_action)',
    (action) => {
      expect(mapGitlabEvent(mergeRequest(action as string), 'msg_1')).toEqual({ kind: 'ignore', reason: 'unmapped_action' });
    },
  );

  it.each(['running', 'pending', 'created', 'canceled', 'skipped', 'manual', 'scheduled', undefined])(
    'pipeline status %p is acknowledged and ignored (unmapped_status)',
    (status) => {
      expect(mapGitlabEvent(pipeline(status as string), 'msg_1')).toEqual({ kind: 'ignore', reason: 'unmapped_status' });
    },
  );

  it.each([
    ['push event', { object_kind: 'push', commits: [] }],
    ['note event', { object_kind: 'note', object_attributes: { note: 'VTID-05541' } }],
    ['no object_kind', { object_attributes: { action: 'open', title: 'VTID-05541' } }],
    ['an array', [mergeRequest('open')]],
    ['a string', 'merge_request'],
    ['null', null],
  ])('%s is acknowledged and ignored (unknown_event)', (_name, payload) => {
    expect(mapGitlabEvent(payload, 'msg_1')).toEqual({ kind: 'ignore', reason: 'unknown_event' });
  });
});

describe('VTID-05541 mapper — the VTID', () => {
  it('merge_request: the first VTID of the merge request title', () => {
    const e = emitted(mapGitlabEvent(mergeRequest('open', { title: 'Fix: VTID-01234 and VTID-05678' }), 'msg_1'));
    expect(e.vtid).toBe('VTID-01234');
  });

  it('merge_request: no VTID in the title → ignored (no_vtid), even when the description or a commit has one', () => {
    const p = mergeRequest('merge', { title: 'no ticket here', description: 'VTID-05541', last_commit: { id: 'x', title: 'VTID-05541' } });
    expect(mapGitlabEvent(p, 'msg_1')).toEqual({ kind: 'ignore', reason: 'no_vtid' });
  });

  it('pipeline: merge_request.title first', () => {
    expect(emitted(mapGitlabEvent(pipeline('success'), 'msg_1')).vtid).toBe('VTID-05541');
  });

  it('pipeline: then commit.title when the merge request title has none or there is no merge request', () => {
    const noMrVtid = pipeline('failed', { merge_request: { iid: 12, title: 'no ticket' } });
    expect(emitted(mapGitlabEvent(noMrVtid, 'msg_1')).vtid).toBe('VTID-05999');
    const noMr = pipeline('success', { merge_request: null });
    expect(emitted(mapGitlabEvent(noMr, 'msg_1')).vtid).toBe('VTID-05999');
  });

  it('pipeline: neither title has one → ignored (no_vtid)', () => {
    const p = pipeline('success', { merge_request: null, commit: { id: 'x', title: 'chore', message: 'VTID-05541 in the body only' } });
    expect(mapGitlabEvent(p, 'msg_1')).toEqual({ kind: 'ignore', reason: 'no_vtid' });
  });

  it('firstVtid takes a whole VTID-\\d{5} only', () => {
    expect(firstVtid('VTID-05541 (lane)')).toBe('VTID-05541');
    expect(firstVtid('[VTID-05541]')).toBe('VTID-05541');
    expect(firstVtid('VTID-123456 is not a VTID')).toBeNull();
    expect(firstVtid('XVTID-12345 is not a VTID')).toBeNull();
    expect(firstVtid('VTID-1234 has four digits')).toBeNull();
    expect(firstVtid(undefined, 42, null, 'then VTID-00001')).toBe('VTID-00001');
    expect(firstVtid()).toBeNull();
  });
});

describe('VTID-05541 mapper — the OASIS event', () => {
  it('merge_request: source, status info, stage VALIDATOR, ids and refs only', () => {
    const e = emitted(mapGitlabEvent(mergeRequest('merge'), 'msg_abc'));
    expect(e).toEqual({
      vtid: 'VTID-05541',
      type: 'scm.gitlab.merge_request.merged',
      source: GITLAB_EVENT_SOURCE,
      status: 'info',
      message: 'GitLab merge request !12 merged in vitana/rehearsal',
      task_stage: 'VALIDATOR',
      payload: {
        gitlab_event: 'merge_request',
        webhook_id: 'msg_abc',
        action: 'merge',
        project_id: 42,
        project_path: 'vitana/rehearsal',
        merge_request_iid: 12,
        state: 'merged',
        source_branch: 'kiro/eng-gitlab-m2/scm-webhook',
        target_branch: 'main',
        head_sha: 'abc0000000000000000000000000000000000002',
        merge_commit_sha: 'c0ffee0000000000000000000000000000000001',
        url: 'https://gitlab.vitanaland.com/vitana/rehearsal/-/merge_requests/12',
      },
    });
    expect(GITLAB_EVENT_SOURCE).toBe('gitlab-webhook');
  });

  it('merge_request: reopen says reopened; every merge request topic is status info', () => {
    expect(emitted(mapGitlabEvent(mergeRequest('reopen'), 'm')).message).toBe('GitLab merge request !12 reopened in vitana/rehearsal');
    for (const action of ['open', 'reopen', 'merge', 'close']) {
      const e = emitted(mapGitlabEvent(mergeRequest(action), 'm'));
      expect(e.status).toBe('info');
      expect(e.task_stage).toBe('VALIDATOR');
    }
  });

  it('pipeline: succeeded is status success, failed is status warning (never error), no stage', () => {
    const ok = emitted(mapGitlabEvent(pipeline('success'), 'msg_p'));
    expect(ok).toEqual({
      vtid: 'VTID-05541',
      type: 'scm.gitlab.pipeline.succeeded',
      source: 'gitlab-webhook',
      status: 'success',
      message: 'GitLab pipeline 31 succeeded on kiro/eng-gitlab-m2/scm-webhook in vitana/rehearsal',
      payload: {
        gitlab_event: 'pipeline',
        webhook_id: 'msg_p',
        status: 'success',
        project_id: 42,
        project_path: 'vitana/rehearsal',
        pipeline_id: 31,
        ref: 'kiro/eng-gitlab-m2/scm-webhook',
        sha: 'abc0000000000000000000000000000000000002',
        source: 'merge_request_event',
        merge_request_iid: 12,
        duration_s: 63,
        url: 'https://gitlab.vitanaland.com/vitana/rehearsal/-/pipelines/31',
      },
    });
    expect('task_stage' in ok).toBe(false);
    const bad = emitted(mapGitlabEvent(pipeline('failed'), 'msg_p'));
    expect(bad.status).toBe('warning');
    expect(bad.message).toBe('GitLab pipeline 31 failed on kiro/eng-gitlab-m2/scm-webhook in vitana/rehearsal');
    expect('task_stage' in bad).toBe(false);
  });

  it('never carries the description, the user, labels, pipeline variables or builds', () => {
    for (const p of [mergeRequest('open'), mergeRequest('merge'), pipeline('success'), pipeline('failed')]) {
      const text = JSON.stringify(emitted(mapGitlabEvent(p, 'm')));
      for (const leak of ['secret-description-text', 'agent@example.invalid', 'Agent Kiro', 'agent-kiro-exafy', 'secret-label', 'SECRET_VARIABLE', 'secret-variable-value', 'builds']) {
        expect(text).not.toContain(leak);
      }
    }
  });

  it('a missing or odd field becomes null; long strings are cut to 512 characters', () => {
    const p = mergeRequest('open', { iid: 'not-a-number', source_branch: 'b'.repeat(2000), url: { nested: true }, last_commit: null });
    delete (p as { project?: unknown }).project;
    const e = emitted(mapGitlabEvent(p, 'w'.repeat(900)));
    expect(e.payload).toMatchObject({ merge_request_iid: null, project_id: null, project_path: null, url: null, head_sha: null });
    expect((e.payload!.source_branch as string).length).toBe(512);
    expect((e.payload!.webhook_id as string).length).toBe(512);
    expect(e.message).toBe('GitLab merge request !? opened in an unknown project');
  });
});

describe('VTID-05541 topics — members of CicdEventType, none reused', () => {
  it('exports exactly the five topics of plan §3.5, all scm.gitlab.*, none cicd.*', () => {
    expect(Object.values(GITLAB_OASIS_TOPICS).sort()).toEqual([...FIVE_TOPICS].sort());
    for (const t of Object.values(GITLAB_OASIS_TOPICS)) {
      expect(t.startsWith('scm.gitlab.')).toBe(true);
      expect(t.startsWith('cicd.')).toBe(false);
    }
  });

  it('each topic is a literal of the CicdEventType union in types/cicd.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'types', 'cicd.ts'), 'utf8');
    const start = src.indexOf('export type CicdEventType =');
    expect(start).toBeGreaterThan(-1);
    // The union ends at the first code line (comments stripped) that ends with ';'.
    const code: string[] = [];
    for (const line of src.slice(start).split('\n')) {
      const c = line.replace(/\/\/.*$/, '');
      code.push(c);
      if (/;\s*$/.test(c)) break;
    }
    const union = code.join('\n');
    expect((union.match(/\| '/g) || []).length).toBeGreaterThan(100); // the whole union, not a fragment
    for (const t of FIVE_TOPICS) expect(union).toContain(`| '${t}'`);
  });
});

describe('VTID-05541 W6 — no GitLab event moves a VTID in this milestone', () => {
  const STATES: AutopilotState[] = [
    'allocated', 'scheduled', 'in_progress', 'building', 'pr_created', 'reviewing',
    'validated', 'merged', 'deploying', 'verifying', 'completed', 'failed',
  ];

  it('no rule of autopilot-event-mapper.ts lists a topic starting scm.gitlab.', () => {
    const listed = EVENT_MAPPING_RULES.flatMap((r) => r.eventTypes);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((t) => t.startsWith('scm.gitlab.'))).toEqual([]);
  });

  it('each of the five events, with the status the route gives it, matches no rule in any state', () => {
    const events = [
      emitted(mapGitlabEvent(mergeRequest('open'), 'a')),
      emitted(mapGitlabEvent(mergeRequest('merge'), 'b')),
      emitted(mapGitlabEvent(mergeRequest('close'), 'c')),
      emitted(mapGitlabEvent(pipeline('success'), 'd')),
      emitted(mapGitlabEvent(pipeline('failed'), 'e')),
    ];
    expect(events.map((e) => e.type).sort()).toEqual([...FIVE_TOPICS].sort());
    for (const e of events) {
      for (const state of STATES) {
        const row = { id: 'x', created_at: '2026-11-05T00:00:00Z', vtid: e.vtid, topic: e.type, status: e.status, task_stage: e.task_stage };
        const r = mapEventToTransition(row, state);
        expect({ topic: e.type, state, matched: r.matched }).toEqual({ topic: e.type, state, matched: false });
      }
    }
  });
});
