/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5): the GitLab event → OASIS topic table, the VTID rule, and the guarantees that
 * no GitLab event reuses a cicd.* topic or moves a VTID's state in this milestone.
 */
import fs from 'fs';
import path from 'path';
import { firstVtid, GITLAB_TOPICS, mapGitlabEvent } from '../../src/services/gitlab-events/map';
import { createDeliveryIdStore } from '../../src/services/gitlab-events/delivery-ids';

const SRC = path.join(__dirname, '..', '..', 'src');
const PROJECT = { id: 3, path_with_namespace: 'vitana/rehearsal' };
const mr = (action: unknown, title: unknown = 'VTID-05541 (eng-gitlab-m2/scm-webhook): route', extra: Record<string, unknown> = {}) => ({
  object_kind: 'merge_request', project: PROJECT,
  object_attributes: { iid: 7, action, title, state: 'opened', url: 'u', source_branch: 's', target_branch: 'main', last_commit: { id: 'a'.repeat(40) }, ...extra },
});
const pipeline = (status: unknown, mrTitle: string | null, commitTitle: string | null) => ({
  object_kind: 'pipeline', project: PROJECT,
  object_attributes: { id: 901, status, ref: 'main', sha: 'c'.repeat(40), source: 'push', duration: 300, queued_duration: 5 },
  merge_request: mrTitle === null ? null : { iid: 7, title: mrTitle, url: 'u' },
  commit: commitTitle === null ? undefined : { id: 'c'.repeat(40), title: commitTitle },
});

describe('VTID-05541 mapGitlabEvent — the event table of plan §3.5', () => {
  test.each([
    ['open', 'scm.gitlab.merge_request.opened', 'info'],
    ['reopen', 'scm.gitlab.merge_request.opened', 'info'],
    ['merge', 'scm.gitlab.merge_request.merged', 'success'],
    ['close', 'scm.gitlab.merge_request.closed', 'info'],
  ])('merge_request action %s → %s', (action, topic, status) => {
    const m = mapGitlabEvent(mr(action));
    expect(m).toMatchObject({ kind: 'emit', topic, vtid: 'VTID-05541', status });
  });

  test.each([
    ['success', 'scm.gitlab.pipeline.succeeded', 'success'],
    ['failed', 'scm.gitlab.pipeline.failed', 'error'],
  ])('pipeline status %s → %s', (st, topic, status) => {
    expect(mapGitlabEvent(pipeline(st, 'VTID-05541 x', null))).toMatchObject({ kind: 'emit', topic, vtid: 'VTID-05541', status });
  });

  test.each(['update', 'approved', 'unapproved', 'approval', 'unapproval', undefined, 42])('merge_request action %p is ignored', (action) => {
    expect(mapGitlabEvent(mr(action)).kind).toBe('ignore');
  });

  test.each(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'canceled', 'skipped', 'manual', 'scheduled', undefined])(
    'pipeline status %p is ignored', (status) => {
      expect(mapGitlabEvent(pipeline(status, 'VTID-05541 x', null)).kind).toBe('ignore');
    });

  test.each([
    ['push', { object_kind: 'push', project: PROJECT }],
    ['note', { object_kind: 'note', project: PROJECT }],
    ['build', { object_kind: 'build', project: PROJECT }],
    ['no object_kind', { project: PROJECT }],
    ['not an object', 'merge_request'],
    ['an array', [mr('open')]],
    ['null', null],
  ])('%s is ignored', (_n, body) => {
    expect(mapGitlabEvent(body).kind).toBe('ignore');
  });

  test('the VTID of a merge request event comes from its title only', () => {
    expect(mapGitlabEvent(mr('open', 'no vtid', { description: 'VTID-05541' })).kind).toBe('ignore');
    expect(mapGitlabEvent(mr('open', null)).kind).toBe('ignore');
  });

  test('a pipeline takes the merge request title first, then the commit title', () => {
    expect(mapGitlabEvent(pipeline('success', 'VTID-05541 mr', 'VTID-05542 commit'))).toMatchObject({ vtid: 'VTID-05541' });
    expect(mapGitlabEvent(pipeline('success', 'no vtid', 'VTID-05542 commit'))).toMatchObject({ vtid: 'VTID-05542' });
    expect(mapGitlabEvent(pipeline('success', null, 'VTID-05542 commit'))).toMatchObject({ vtid: 'VTID-05542' });
    expect(mapGitlabEvent(pipeline('success', null, null)).kind).toBe('ignore');
  });

  test('firstVtid takes the first five-digit VTID and never the start of a longer number', () => {
    expect(firstVtid('VTID-05541 and VTID-05542')).toBe('VTID-05541');
    expect(firstVtid('VTID-055411')).toBeNull();
    expect(firstVtid('XVTID-05541')).toBeNull();
    expect(firstVtid('(VTID-05541)')).toBe('VTID-05541');
    expect(firstVtid(undefined, 42, 'VTID-00001')).toBe('VTID-00001');
    expect(firstVtid('VTID-0554')).toBeNull();
  });

  test('the payload carries identifiers, not bodies; titles are cut', () => {
    const long = `VTID-05541 ${'t'.repeat(500)}`;
    const m = mapGitlabEvent(mr('open', long, { description: 'secret plan text' }));
    if (m.kind !== 'emit') throw new Error('expected emit');
    expect(JSON.stringify(m.payload)).not.toContain('secret plan text');
    expect(String(m.payload.title).length).toBeLessThanOrEqual(201);
    expect(m.payload).toMatchObject({ host: 'gitlab', project: 'vitana/rehearsal', project_id: 3, iid: 7, head_sha: 'a'.repeat(40) });
  });

  test('all five topics are new scm.gitlab.* names, none of them an existing cicd.* topic', () => {
    expect(GITLAB_TOPICS).toHaveLength(5);
    for (const t of GITLAB_TOPICS) expect(t.startsWith('scm.gitlab.')).toBe(true);
    const types = fs.readFileSync(path.join(SRC, 'types', 'cicd.ts'), 'utf8');
    for (const t of GITLAB_TOPICS) expect(types).toContain(`| '${t}'`);
  });

  test('no rule of autopilot-event-mapper.ts lists a scm.gitlab.* topic, so no GitLab event moves a VTID in this milestone', () => {
    const mapper = fs.readFileSync(path.join(SRC, 'services', 'autopilot-event-mapper.ts'), 'utf8');
    expect(mapper).not.toMatch(/scm\.gitlab\./);
    for (const t of GITLAB_TOPICS) expect(mapper).not.toContain(t);
  });

  test('the route and the mapper emit no existing cicd.* topic', () => {
    for (const file of [path.join(SRC, 'routes', 'internal-gitlab-webhook.ts'), path.join(SRC, 'services', 'gitlab-events', 'map.ts')]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(/['"]cicd\.[a-z_.]+['"]/);
    }
  });
});

describe('VTID-05541 createDeliveryIdStore — dedupe of resends per gateway task', () => {
  test('remembers an id and answers has()', () => {
    const s = createDeliveryIdStore({ now: () => 0 });
    expect(s.has('a')).toBe(false);
    s.remember('a');
    expect(s.has('a')).toBe(true);
    expect(s.size()).toBe(1);
  });

  test('forgets an id after its time to live', () => {
    let t = 0;
    const s = createDeliveryIdStore({ ttlMs: 1000, now: () => t });
    s.remember('a');
    t = 999;
    expect(s.has('a')).toBe(true);
    t = 1000;
    expect(s.has('a')).toBe(false);
  });

  test('keeps at most maxEntries, dropping the oldest first', () => {
    let t = 0;
    const s = createDeliveryIdStore({ maxEntries: 2, now: () => t++ });
    s.remember('a');
    s.remember('b');
    s.remember('c');
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(true);
    expect(s.has('c')).toBe(true);
    expect(s.size()).toBe(2);
  });

  test('refuses nonsense limits', () => {
    expect(() => createDeliveryIdStore({ maxEntries: 0 })).toThrow();
    expect(() => createDeliveryIdStore({ ttlMs: 0 })).toThrow();
  });
});
