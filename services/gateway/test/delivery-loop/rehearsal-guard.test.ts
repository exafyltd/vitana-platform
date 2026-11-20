/**
 * The rehearsal helper (scripts/delivery-loop/rehearse.ts) is what stands between a hand-run script and a real GitLab project. Its rules
 * are tested against a recording fake transport: it must be unable to change `main`, unable to touch an object it did not create, and
 * unable to run on any project but the scratch one. There is no generic "send this body" call to get around a rule with spacing or a
 * differently named key.
 */
import { BRANCH_PREFIX, PREFIX, REHEARSAL_PROJECT, Refused, Rehearsal, type RehearsalTransport } from '../../../../scripts/delivery-loop/rehearse';

type Sent = { method: string; url: string; body: any };
function fake(answer: (s: Sent) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const sent: Sent[] = [];
  const t: RehearsalTransport = {
    baseUrl: 'https://gitlab.test/api/v4',
    token: 'glpat-testtoken123456',
    headers: { environmentId: 'e1' },
    fetch: (async (url: string, init: RequestInit = {}) => {
      const s = { method: String(init.method ?? 'GET'), url: String(url), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
      sent.push(s);
      const a = answer(s);
      return new Response([204, 205, 304].includes(a.status) ? null : JSON.stringify(a.body), { status: a.status });
    }) as unknown as typeof fetch,
  };
  return { t, sent };
}
const writes = (sent: Sent[]) => sent.filter((s) => s.method !== 'GET');

describe('a run id and its branch', () => {
  it('a run id is 4 to 12 lowercase letters or digits, and the branch carries the prefix and the id', () => {
    expect(new Rehearsal(fake().t, 'a1b2c3').branch).toBe(`${BRANCH_PREFIX}a1b2c3`);
    for (const bad of ['', 'abc', 'ABCDEF', 'a b c d', 'a/b/c/d', '../main', 'x'.repeat(13), 'main', 'master', 'prod', 'test', 'staging']) expect(() => new Rehearsal(fake().t, bad)).toThrow(Refused);
  });
});

describe('the branch the rehearsal makes is one the loop owns', () => {
  it('BRANCH_PREFIX is accepted by DELIVERY_LOOP_BRANCH_PREFIXES, so the engine under test really owns the branch it is asked to repair', () => {
    // The first real run failed at exactly this: a prefix without a trailing slash is refused by the loop on purpose (so a bare name cannot
    // widen), the loop then owned no branch and correctly left the failing pipeline alone. The rehearsal must use a valid prefix.
    const { branchPrefixesFrom, ownsBranch } = jest.requireActual('../../src/services/delivery-loop/controls') as typeof import('../../src/services/delivery-loop/controls');
    const env = { DELIVERY_LOOP_BRANCH_PREFIXES: BRANCH_PREFIX } as NodeJS.ProcessEnv;
    expect(branchPrefixesFrom(env)).toEqual([BRANCH_PREFIX]);
    const r = new Rehearsal(fake().t, 'a1b2c3');
    expect(ownsBranch({ branchPrefixes: branchPrefixesFrom(env), healMain: false }, r.branch, 'heal')).toBe(true);
    expect(ownsBranch({ branchPrefixes: branchPrefixesFrom(env), healMain: false }, 'main', 'heal')).toBe(false);
    // and the dashed form is refused, which is what the first run tripped on
    expect(branchPrefixesFrom({ DELIVERY_LOOP_BRANCH_PREFIXES: PREFIX } as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe('it can never change main', () => {
  it.each(['main', 'master', 'loop-rehearsal/other', 'loop-rehearsal/', 'loop-rehearsal/a1b2c3/../main', 'loop-rehearsal-a1b2c3', 'kiro/some/lane', 'pilot/mr-review-a4', 'shadow/platform-main', 'Loop-Rehearsal/a1b2c3', ' loop-rehearsal/a1b2c3'])('%s is refused by every write that takes a branch', async (name) => {
    const { t, sent } = fake();
    const r = new Rehearsal(t, 'a1b2c3');
    await expect(r.createBranch(name)).rejects.toThrow(Refused);
    await expect(r.commit(name, 'm', { 'a.txt': 'x' })).rejects.toThrow(Refused);
    await expect(r.openMergeRequest(name, 't', 'd')).rejects.toThrow(Refused);
    expect(writes(sent)).toEqual([]);
    expect(sent).toEqual([]); // not even a read happened for a refused branch
  });

  it('there is no generic write: nothing public takes a path or a body', () => {
    const r = new Rehearsal(fake().t, 'a1b2c3') as unknown as Record<string, unknown>;
    // What a caller can reach: named operations that take a branch or an id, and the engine's own client. `raw` and `ownBranch` are private
    // in the type; this checks the runtime shape too, so a public `send(path, body)` added later fails here.
    const publicMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(r)).filter((n) => n !== 'constructor' && typeof (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(r), n)?.value) === 'function' && n !== 'raw' && n !== 'ownBranch');
    expect(publicMethods.sort()).toEqual(['cleanup', 'commit', 'createBranch', 'labelIssue', 'openIssue', 'openMergeRequest', 'projectIsPrivate', 'retryOwnPipeline']);
    for (const name of publicMethods) expect(name).not.toMatch(/^(send|call|request|post|put|delete|write|exec|raw)/i);
  });

  it('a merge request always targets main (it is the only place main appears, and as a target, never as a thing changed)', async () => {
    const { t, sent } = fake((s) => (s.url.endsWith('/merge_requests') ? { status: 201, body: { iid: 7 } } : { status: 200, body: {} }));
    const r = new Rehearsal(t, 'a1b2c3');
    await r.openMergeRequest(r.branch, 'title', 'body');
    expect(sent[0].body).toMatchObject({ source_branch: r.branch, target_branch: 'main', remove_source_branch: true });
  });
});

describe('retrying a pipeline: only one that ran on this run\'s own merge request or branch', () => {
  const pipelineAnswer = (ref: string) => (s: Sent) => {
    if (s.method === 'GET' && /\/pipelines\/\d+$/.test(s.url)) return { status: 200, body: { id: 77, ref, status: 'failed', sha: 'abc' } };
    if (s.method === 'POST' && /\/pipelines\/77\/retry$/.test(s.url)) return { status: 201, body: { id: 77, ref, status: 'pending', sha: 'abc' } };
    if (s.method === 'POST' && s.url.endsWith('/merge_requests')) return { status: 201, body: { iid: 7 } };
    return { status: 200, body: {} };
  };

  it('retries a pipeline of a merge request this run opened: it reads the pipeline first, then retries it, with no body', async () => {
    const { t, sent } = fake(pipelineAnswer('refs/merge-requests/7/head'));
    const r = new Rehearsal(t, 'a1b2c3');
    await r.openMergeRequest(r.branch, 'title', 'body');
    sent.length = 0;
    const result = await r.retryOwnPipeline(77);
    expect(result).toEqual({ id: 77, status: 'pending' });
    expect(sent.map((s) => `${s.method} ${s.url.replace(/^.*\/projects\/[^/]+/, '')}`)).toEqual(['GET /pipelines/77', 'POST /pipelines/77/retry']);
    expect(sent[1].body).toBeUndefined();
  });

  it('retries a pipeline that ran on this run\'s own branch, once the run has created that branch', async () => {
    const { t, sent } = fake((s) => (s.method === 'POST' && s.url.endsWith('/repository/branches') ? { status: 201, body: {} } : pipelineAnswer('loop-rehearsal/a1b2c3')(s)));
    const r = new Rehearsal(t, 'a1b2c3');
    await expect(r.retryOwnPipeline(77)).rejects.toThrow(Refused); // not created yet: refused, even though the name is this run's
    await r.createBranch();
    sent.length = 0;
    await r.retryOwnPipeline(77);
    expect(writes(sent).map((s) => s.url.replace(/^.*\/projects\/[^/]+/, ''))).toEqual(['/pipelines/77/retry']);
  });

  it.each([
    ['main', 'main'],
    ['a merge request this run did not open', 'refs/merge-requests/1/head'],
    ['a merge request of the pilot', 'refs/merge-requests/2/head'],
    ['another run\'s branch', 'loop-rehearsal/zzzzzz'],
    ['a branch people work on', 'pilot/mr-review-a4'],
    ['a tag', 'refs/tags/v1'],
    ['an empty ref', ''],
  ])('refuses a pipeline on %s: it is read, and nothing is written', async (_what, ref) => {
    const { t, sent } = fake(pipelineAnswer(ref));
    const r = new Rehearsal(t, 'a1b2c3');
    await r.openMergeRequest(r.branch, 'title', 'body'); // creates !7 only
    sent.length = 0;
    await expect(r.retryOwnPipeline(77)).rejects.toThrow(Refused);
    expect(writes(sent)).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('refuses the id %p with no request at all', async (id) => {
    const { t, sent } = fake();
    await expect(new Rehearsal(t, 'a1b2c3').retryOwnPipeline(id)).rejects.toThrow(Refused);
    expect(sent).toEqual([]);
  });

  it('a pipeline GitLab does not know, or a retry GitLab refuses, is an error and never a success', async () => {
    const missing = fake(() => ({ status: 404, body: { message: '404 Not found' } }));
    await expect(new Rehearsal(missing.t, 'a1b2c3').retryOwnPipeline(77)).rejects.toThrow(/404/);
    const refused = fake((s) => {
      if (s.method === 'POST' && s.url.endsWith('/repository/branches')) return { status: 201, body: {} };
      return s.method === 'POST' ? { status: 403, body: { message: 'forbidden' } } : { status: 200, body: { id: 77, ref: 'loop-rehearsal/a1b2c3', status: 'failed' } };
    });
    const r = new Rehearsal(refused.t, 'a1b2c3');
    await r.createBranch();
    await expect(r.retryOwnPipeline(77)).rejects.toThrow(/403/);
  });
});

describe('it only touches what it created', () => {
  it('labelling an issue it did not create is refused with no request', async () => {
    const { t, sent } = fake();
    const r = new Rehearsal(t, 'a1b2c3');
    await expect(r.labelIssue(1, ['agent-task'])).rejects.toThrow(Refused);
    expect(sent).toEqual([]);
  });

  it('creates an issue with the run\'s prefix in its title, and may then label it', async () => {
    const { t, sent } = fake((s) => (s.method === 'POST' ? { status: 201, body: { iid: 41 } } : { status: 200, body: {} }));
    const r = new Rehearsal(t, 'a1b2c3');
    const iid = await r.openIssue('add a retry button', 'description', ['bug']);
    expect(sent[0].body.title).toBe(`${PREFIX}a1b2c3: add a retry button`);
    await r.labelIssue(iid, ['agent-task']);
    expect(sent[1]).toMatchObject({ method: 'PUT', body: { add_labels: 'agent-task' } });
  });

  it('cleanup closes its merge requests and issues and deletes its branches, nothing else, and says what it could not remove', async () => {
    const { t, sent } = fake((s) => {
      if (s.method === 'POST' && s.url.endsWith('/repository/branches')) return { status: 201, body: {} };
      if (s.method === 'POST' && s.url.endsWith('/merge_requests')) return { status: 201, body: { iid: 7 } };
      if (s.method === 'POST' && s.url.endsWith('/issues')) return { status: 201, body: { iid: 41 } };
      if (s.method === 'PUT' && s.url.includes('/issues/41')) return { status: 500, body: {} }; // one thing cannot be closed
      if (s.method === 'DELETE') return { status: 204, body: {} };
      return { status: 200, body: {} };
    });
    const r = new Rehearsal(t, 'a1b2c3');
    await r.createBranch();
    await r.openMergeRequest(r.branch, 't', 'd');
    await r.openIssue('t', 'd', []);
    const before = sent.length;
    const left = await r.cleanup();
    const after = sent.slice(before);
    expect(after.map((s) => `${s.method} ${s.url.replace(/.*projects\/[^/]+/, '')}`)).toEqual([
      'PUT /merge_requests/7',
      'PUT /issues/41',
      `DELETE /repository/branches/${encodeURIComponent(r.branch)}`,
    ]);
    expect(left).toEqual(['issue #41 (500)']);
  });

  it('cleanup of a run that created nothing sends nothing', async () => {
    const { t, sent } = fake();
    expect(await new Rehearsal(t, 'a1b2c3').cleanup()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a thing already gone (404) is not a leftover', async () => {
    const { t } = fake((s) => (s.method === 'POST' ? { status: 201, body: { iid: 3 } } : { status: 404, body: {} }));
    const r = new Rehearsal(t, 'a1b2c3');
    await r.openMergeRequest(r.branch, 't', 'd');
    expect(await r.cleanup()).toEqual([]);
  });
});

describe('the project and the token', () => {
  it('every request goes to the scratch project, and the token travels only in PRIVATE-TOKEN', async () => {
    const { t, sent } = fake((s) => (s.method === 'POST' ? { status: 201, body: { iid: 1 } } : { status: 200, body: { visibility: 'private', path_with_namespace: REHEARSAL_PROJECT } }));
    const r = new Rehearsal(t, 'a1b2c3');
    expect(await r.projectIsPrivate()).toBe(true);
    await r.createBranch();
    for (const s of sent) {
      expect(s.url).toContain(`/projects/${encodeURIComponent(REHEARSAL_PROJECT)}`);
      expect(s.url).not.toContain('glpat');
      expect(JSON.stringify(s.body ?? {})).not.toContain('glpat');
    }
    expect(r.log.join('\n')).not.toContain('glpat');
  });

  it('a project that is not private, or is not the scratch one, is not a project to run on', async () => {
    expect(await new Rehearsal(fake(() => ({ status: 200, body: { visibility: 'public', path_with_namespace: REHEARSAL_PROJECT } })).t, 'a1b2c3').projectIsPrivate()).toBe(false);
    expect(await new Rehearsal(fake(() => ({ status: 200, body: { visibility: 'private', path_with_namespace: 'vitana/vitana-platform' } })).t, 'a1b2c3').projectIsPrivate()).toBe(false);
    expect(await new Rehearsal(fake(() => ({ status: 404, body: {} })).t, 'a1b2c3').projectIsPrivate()).toBe(false);
  });

  it('the engine\'s own client is allowed the scratch project and no other', async () => {
    const { t } = fake();
    const c = new Rehearsal(t, 'a1b2c3').client;
    expect(await c.getIssue('vitana/vitana-platform', 1)).toEqual({ ok: false, error: 'project_not_allowed' });
  });
});
