/**
 * Delivery loop test harness (not a test file: the Jest pattern is *.test.ts). A fake GitLab with the behaviour the loop depends on,
 * fakes for the executor, the reviewer and the memory, and a clock. Nothing here touches a network.
 *
 * The fake GitLab models what matters, not everything: issues with label events and a member table, merge requests, pipelines with jobs
 * and logs, a retry that moves a pipeline's `updated_at` without a new id (as GitLab does), and an outage switch.
 */
import { createHash } from 'crypto';
import type { GitlabClient } from '../../src/services/delivery-loop/gitlab-client';
import { MemoryLedger } from '../../src/services/delivery-loop/ledger';
import { createEngine, type Engine } from '../../src/services/delivery-loop/engine';
import type { LoopDeps } from '../../src/services/delivery-loop/context';
import type { DispatchResult, KnownFix, LearnPort, OutcomeLesson, RepairLesson, ReviewVerdict, ReviewerPort, TaskPort, TaskRequest } from '../../src/services/delivery-loop/ports';
import type { GitlabDiffFile, GitlabIssue, GitlabJob, GitlabLabelEvent, GitlabMergeRequest, GitlabPipeline, GitlabResult } from '../../src/services/delivery-loop/types';

export const PROJECT = 'vitana/rehearsal';
export const T0 = Date.parse('2026-11-19T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

export class Clock {
  constructor(public ms = T0) {}
  now = () => this.ms;
  advance(ms: number) {
    this.ms += ms;
  }
}

export type FakePipeline = GitlabPipeline & { jobs: GitlabJob[]; traces: Record<number, string> };

/** An in-memory GitLab. `down` makes every call fail like an outage; `calls` records every call for assertions. */
export class FakeGitlab implements GitlabClient {
  issues = new Map<number, GitlabIssue>();
  labelEvents = new Map<number, GitlabLabelEvent[]>();
  members = new Map<number, number>();
  mrs = new Map<number, GitlabMergeRequest>();
  diffs = new Map<number, GitlabDiffFile[]>();
  pipelines = new Map<number, FakePipeline>();
  notes: Array<{ target: 'issue' | 'mr'; iid: number; body: string }> = [];
  calls: string[] = [];
  down = false;
  failOnce = new Set<string>();
  retried: number[] = [];
  createdIssues: Array<{ iid: number; title: string; description: string; labels: string[] }> = [];
  private nextId = 1000;

  constructor(private readonly clock: Clock) {}

  /** Every object of this fake lives in PROJECT: any other project has no issues, merge requests or pipelines (a list is empty, a single is a 404). */
  private gate<T>(name: string, project: string, run: () => GitlabResult<T>): Promise<GitlabResult<T>> {
    this.calls.push(`${name}@${project}`);
    this.calls.push(name);
    if (this.down) return Promise.resolve({ ok: false, error: 'network_error' });
    if (this.failOnce.delete(name)) return Promise.resolve({ ok: false, error: 'http_500: boom', status: 500 });
    if (project !== PROJECT) return Promise.resolve(name.startsWith('list') ? ({ ok: true, data: [] } as unknown as GitlabResult<T>) : this.notFound<T>());
    return Promise.resolve(run());
  }
  private notFound<T>(): GitlabResult<T> {
    return { ok: false, error: 'http_404: 404 Not found', status: 404 };
  }

  // ---- setup helpers --------------------------------------------------------------------------------------
  addIssue(over: Partial<GitlabIssue> & { iid: number }, labeledBy: { user_id: number; level: number | null } | null = { user_id: 7, level: 40 }): GitlabIssue {
    const issue: GitlabIssue = {
      id: 300 + over.iid, title: 'Add a retry button to the export screen', description: 'The export screen should have a retry button when the export fails, next to the error.',
      state: 'opened', labels: ['agent-task'], web_url: `https://gitlab.test/${PROJECT}/-/issues/${over.iid}`, confidential: false, updated_at: iso(this.clock.now()), author_id: 7, ...over,
    };
    this.issues.set(issue.iid, issue);
    if (labeledBy) {
      this.members.set(labeledBy.user_id, labeledBy.level ?? -1);
      if (labeledBy.level === null) this.members.delete(labeledBy.user_id);
      this.labelEvents.set(issue.iid, [{ id: this.nextId++, label: 'agent-task', action: 'add', user_id: labeledBy.user_id, username: `user${labeledBy.user_id}`, created_at: iso(this.clock.now()) }]);
    }
    return issue;
  }

  addMr(over: Partial<GitlabMergeRequest> & { iid: number; source_branch: string }): GitlabMergeRequest {
    const mr: GitlabMergeRequest = {
      id: 500 + over.iid, title: 'Repair', description: '', state: 'opened', draft: false, target_branch: 'main', sha: `head${over.iid}`.padEnd(40, '0'),
      web_url: `https://gitlab.test/${PROJECT}/-/merge_requests/${over.iid}`, labels: [], head_pipeline_id: null, ...over,
    };
    this.mrs.set(mr.iid, mr);
    return mr;
  }

  /** A pipeline on a ref. `jobs` default to one failed script job when `status` is failed. */
  addPipeline(over: { id: number; status: string; ref: string; sha?: string; jobs?: Array<Partial<GitlabJob> & { id: number; name: string }>; log?: string; at?: number }): FakePipeline {
    const at = iso(over.at ?? this.clock.now());
    const jobs = (over.jobs ?? (over.status === 'failed' ? [{ id: over.id * 10, name: 'unit', status: 'failed', failure_reason: 'script_failure' }] : [])).map((j) => ({
      stage: 'test', status: 'failed', failure_reason: 'script_failure', allow_failure: false, web_url: `https://gitlab.test/jobs/${j.id}`, ...j,
    })) as GitlabJob[];
    const traces: Record<number, string> = {};
    for (const j of jobs) traces[j.id] = over.log ?? `2026-11-19T10:00:01.000000Z 01O not ok 1 - handles the empty case\n2026-11-19T10:00:01.000000Z 01O   error: |-\n2026-11-19T10:00:01.000000Z 01O     Expected values to be strictly equal: 10 !== 11\n2026-11-19T10:00:02.000000Z 00O ERROR: Job failed: exit code 1\n`;
    const p: FakePipeline = { id: over.id, status: over.status, ref: over.ref, sha: over.sha ?? `sha${over.id}`.padEnd(40, '0'), web_url: `https://gitlab.test/${PROJECT}/-/pipelines/${over.id}`, source: 'push', created_at: at, updated_at: at, jobs, traces };
    this.pipelines.set(p.id, p);
    return p;
  }

  /** A pipeline moves (runs, passes, fails): its updated_at moves with it, its id does not. */
  setPipeline(id: number, status: string) {
    const p = this.pipelines.get(id);
    if (!p) throw new Error(`no pipeline ${id}`);
    p.status = status;
    p.updated_at = iso(this.clock.now());
  }

  // ---- the client -----------------------------------------------------------------------------------------
  getIssue = (p: string, iid: number): Promise<GitlabResult<GitlabIssue>> => this.gate('getIssue', p, () => (this.issues.has(iid) ? { ok: true, data: this.issues.get(iid) as GitlabIssue } : this.notFound<GitlabIssue>()));
  listIssues = (p: string, q: { labels?: string[]; state?: string; updatedAfter?: string } = {}) =>
    this.gate('listIssues', p, () => ({
      ok: true,
      data: [...this.issues.values()].filter((i) => (!q.labels || q.labels.every((l) => i.labels.includes(l))) && (!q.state || q.state === 'all' || i.state === q.state) && (!q.updatedAfter || i.updated_at >= q.updatedAfter)),
    }));
  commentIssue = (p: string, iid: number, body: string) => this.gate('commentIssue', p, () => (this.notes.push({ target: 'issue', iid, body }), { ok: true, data: { id: this.nextId++ } }));
  commentMergeRequest = (p: string, iid: number, body: string) => this.gate('commentMergeRequest', p, () => (this.notes.push({ target: 'mr', iid, body }), { ok: true, data: { id: this.nextId++ } }));
  listIssueLabelEvents = (p: string, iid: number) => this.gate('listIssueLabelEvents', p, () => ({ ok: true, data: this.labelEvents.get(iid) ?? [] }));
  getMemberAccessLevel = (p: string, userId: number) => this.gate('getMemberAccessLevel', p, () => ({ ok: true, data: this.members.has(userId) ? (this.members.get(userId) as number) : null }));
  createIssue = (p: string, input: { title: string; description: string; labels?: string[] }) =>
    this.gate('createIssue', p, () => {
      const iid = 900 + this.createdIssues.length;
      this.createdIssues.push({ iid, title: input.title, description: input.description, labels: input.labels ?? [] });
      return { ok: true, data: { id: iid, iid, title: input.title, description: input.description, state: 'opened', labels: input.labels ?? [], web_url: `https://gitlab.test/${PROJECT}/-/issues/${iid}`, confidential: false, updated_at: iso(this.clock.now()), author_id: 1 } };
    });
  updateIssueLabels = (p: string, iid: number, change: { add?: string[]; remove?: string[] }): Promise<GitlabResult<GitlabIssue>> =>
    this.gate('updateIssueLabels', p, () => {
      const i = this.issues.get(iid);
      if (!i) return this.notFound<GitlabIssue>();
      i.labels = [...new Set([...i.labels, ...(change.add ?? [])])].filter((l) => !(change.remove ?? []).includes(l));
      return { ok: true, data: i };
    });
  getMergeRequest = (p: string, iid: number): Promise<GitlabResult<GitlabMergeRequest>> => this.gate('getMergeRequest', p, () => (this.mrs.has(iid) ? { ok: true, data: this.mrs.get(iid) as GitlabMergeRequest } : this.notFound<GitlabMergeRequest>()));
  listMergeRequests = (p: string) => this.gate('listMergeRequests', p, () => ({ ok: true, data: [...this.mrs.values()] }));
  createMergeRequest = (p: string) => this.gate('createMergeRequest', p, () => ({ ok: false, error: 'not used by the loop' }) as GitlabResult<GitlabMergeRequest>);
  getMergeRequestDiffs = (p: string, iid: number) => this.gate('getMergeRequestDiffs', p, () => ({ ok: true, data: this.diffs.get(iid) ?? [{ old_path: 'a.ts', new_path: 'a.ts', new_file: false, deleted_file: false, diff: '@@ -1 +1 @@\n-old\n+new\n' }] }));
  getPipeline = (p: string, id: number): Promise<GitlabResult<GitlabPipeline>> => this.gate('getPipeline', p, () => (this.pipelines.has(id) ? { ok: true, data: this.pipelines.get(id) as GitlabPipeline } : this.notFound<GitlabPipeline>()));
  latestPipeline = (p: string, ref: string) =>
    this.gate('latestPipeline', p, () => {
      const mine = [...this.pipelines.values()].filter((p) => p.ref === ref).sort((a, b) => b.id - a.id);
      return { ok: true, data: mine[0] ?? null };
    });
  listPipelines = (p: string, q: { status: string; updatedAfter: string }) =>
    this.gate('listPipelines', p, () => ({ ok: true, data: [...this.pipelines.values()].filter((p) => p.status === q.status && p.updated_at >= q.updatedAfter).sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1)) }));
  listPipelineJobs = (p: string, id: number, q: { failedOnly?: boolean } = {}) =>
    this.gate('listPipelineJobs', p, () => ({ ok: true, data: (this.pipelines.get(id)?.jobs ?? []).filter((j) => !q.failedOnly || j.status === 'failed') }));
  getJobTrace = (p: string, jobId: number): Promise<GitlabResult<string>> =>
    this.gate('getJobTrace', p, () => {
      for (const pl of this.pipelines.values()) if (pl.traces[jobId] !== undefined) return { ok: true, data: pl.traces[jobId] };
      return this.notFound<string>();
    });
  retryPipeline = (project: string, id: number): Promise<GitlabResult<GitlabPipeline>> =>
    this.gate('retryPipeline', project, () => {
      const pl = this.pipelines.get(id);
      if (!pl) return this.notFound<GitlabPipeline>();
      this.retried.push(id);
      this.setPipeline(id, 'running'); // same id, moved
      return { ok: true, data: pl };
    });

  /** Calls by bare name (the `name@project` entries are for tests that care which project was touched). */
  bare = () => this.calls.filter((c) => !c.includes('@'));
  count = (name: string) => this.calls.filter((c) => c === name).length;
  writes = () => this.calls.filter((c) => ['commentIssue', 'commentMergeRequest', 'updateIssueLabels', 'retryPipeline', 'createIssue'].includes(c)).length;
  touched = (project: string) => this.calls.some((c) => c.endsWith(`@${project}`));
}

export class FakeTasks implements TaskPort {
  requests: TaskRequest[] = [];
  result: DispatchResult | ((r: TaskRequest) => DispatchResult) = { ok: true, task_id: 'task-1', vtid: null, execution_id: 'exec-1' };
  async dispatch(r: TaskRequest): Promise<DispatchResult> {
    this.requests.push(r);
    const res = typeof this.result === 'function' ? this.result(r) : this.result;
    return res.ok ? { ...res, task_id: `task-${this.requests.length}`, execution_id: `exec-${this.requests.length}` } : res;
  }
}

export class FakeReviewer implements ReviewerPort {
  inputs: Array<{ project: string; iid: number; head: string | null; files: number }> = [];
  verdict: 'accept' | 'changes' | ((n: number) => 'accept' | 'changes') = 'accept';
  findings = ['The new branch has no test for the empty case.', 'The error message is not translated.'];
  down = false;
  /** When set, the verdict is about this head instead of the merge request's: a stale verdict. */
  reviewedHead: string | null = null;
  async review(input: { project: string; mr: GitlabMergeRequest; diffs: GitlabDiffFile[] }) {
    this.inputs.push({ project: input.project, iid: input.mr.iid, head: input.mr.sha, files: input.diffs.length });
    if (this.down) return { ok: false as const, error: 'model_unavailable' };
    const v = typeof this.verdict === 'function' ? this.verdict(this.inputs.length) : this.verdict;
    const data: ReviewVerdict = { verdict: v, summary: v === 'accept' ? 'The change does what it says.' : 'Two things are missing.', findings: v === 'changes' ? this.findings : [], model: 'fake-model', reviewed_head: this.reviewedHead ?? (input.mr.sha as string) };
    return { ok: true as const, data };
  }
}

export class FakeLearn implements LearnPort {
  repairs: RepairLesson[] = [];
  outcomes: OutcomeLesson[] = [];
  known = new Map<string, KnownFix>();
  down = false;
  async recordRepair(l: RepairLesson) {
    if (this.down) return { ok: false, error: 'memory_down' };
    this.repairs.push(l);
    this.known.set(l.fingerprint, { fingerprint: l.fingerprint, summary: `fixed in ${l.mr_url ?? 'a merge request'}`, success_count: 1 });
    return { ok: true };
  }
  async recordOutcome(l: OutcomeLesson) {
    if (this.down) return { ok: false, error: 'memory_down' };
    this.outcomes.push(l);
    return { ok: true };
  }
  async findKnownFix(_p: string, fp: string) {
    return this.known.get(fp) ?? null;
  }
}

export interface World {
  clock: Clock;
  gitlab: FakeGitlab;
  ledger: MemoryLedger;
  tasks: FakeTasks;
  reviewer: FakeReviewer;
  learn: FakeLearn;
  engine: Engine;
  armed: { value: boolean };
  env: NodeJS.ProcessEnv;
  /**
   * Runs one cycle, then moves the clock on. The engine runs once per window (a window is one cycle length, 60 s, and one gateway task
   * wins it), so a tick that moves the clock less than a window would run the next cycle in the SAME window and be refused its claim:
   * that is the engine working, so `tick` always ends at the start of a later window, and `ms` only adds time on top of that.
   */
  tick: (ms?: number) => ReturnType<Engine['cycle']>;
  /** Writes a webhook fact the way the stage does. */
  fact: (topic: string, payload: Record<string, unknown>, key?: string) => void;
  /** The facts of a failed or green pipeline as the webhook stage records them. */
  pipelineFact: (status: 'failed' | 'succeeded', p: FakePipeline, extra?: Record<string, unknown>) => void;
  issueFact: (iid: number, topic?: 'scm.gitlab.issue.opened' | 'scm.gitlab.issue.labeled') => void;
}

export function world(env: Record<string, string> = {}, opts: { reviewer?: boolean } = {}): World {
  const clock = new Clock();
  const gitlab = new FakeGitlab(clock);
  const ledger = new MemoryLedger({ now: clock.now, env: 'staging' });
  const tasks = new FakeTasks();
  const reviewer = new FakeReviewer();
  const learn = new FakeLearn();
  const armed = { value: true };
  const e = {
    DELIVERY_LOOP_ENABLED: 'true',
    DELIVERY_LOOP_AUTONOMY: 'L3',
    DELIVERY_LOOP_PROJECTS: PROJECT,
    DELIVERY_LOOP_MAX_ACTIONS: '20',
    ...env,
  } as NodeJS.ProcessEnv;
  const deps: LoopDeps = { gitlab, ledger, tasks, reviewer: opts.reviewer === false ? null : reviewer, learn, now: clock.now };
  const engine = createEngine({ deps, env: e, isArmed: async () => armed.value, cycleMs: 60_000 });

  const w: World = {
    clock, gitlab, ledger, tasks, reviewer, learn, engine, armed, env: e,
    async tick(ms = 0) {
      const r = await engine.cycle();
      const WINDOW = 60_000;
      clock.advance(WINDOW - (clock.now() % WINDOW) + ms); // to the start of the next window, plus ms
      return r;
    },
    fact(topic, payload, key) {
      ledger.insert({ type: topic, status: 'info', message: topic, payload: { plane: 'delivery', host: 'gitlab', mode: 'shadow', repo: 'rehearsal', ...payload, dedupe_key: key ?? `fact:${createHash('sha1').update(topic + JSON.stringify(payload)).digest('hex').slice(0, 12)}` }, key });
    },
    pipelineFact(status, p, extra = {}) {
      const branch = p.ref.replace(/^refs\/merge-requests\/\d+\/head$/, '');
      w.fact(
        `scm.gitlab.pipeline.${status}`,
        {
          project_path: PROJECT, pipeline_id: p.id, ref: p.ref, sha: p.sha, url: p.web_url, tag: false, status: status === 'failed' ? 'failed' : 'success',
          merge_request_iid: null, mr_source_branch: branch || null, mr_target_branch: 'main', mr_url: null, lane_key: null,
          ...(status === 'failed' ? { failed_jobs: p.jobs.filter((j) => j.status === 'failed').map((j) => ({ id: j.id, name: j.name, stage: j.stage, failure_reason: j.failure_reason, exit_code: 1 })) } : {}),
          ...extra,
        },
        `gitlab:${PROJECT}:pipeline:${p.id}:${status === 'failed' ? 'failed' : 'success'}`,
      );
    },
    issueFact(iid, topic = 'scm.gitlab.issue.opened') {
      const i = gitlab.issues.get(iid) as GitlabIssue;
      w.fact(topic, { project_path: PROJECT, issue_iid: iid, issue_id: i.id, url: i.web_url, confidential: i.confidential, labels: i.labels, state: i.state }, `gitlab:${PROJECT}:issue:${iid}:${topic}:${i.updated_at}`);
    },
  };
  return w;
}

export const topics = (w: World, t: string) => w.ledger.topic(t);
