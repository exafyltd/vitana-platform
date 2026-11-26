/**
 * Delivery loop rehearsal: the engine of services/delivery-loop against a REAL GitLab project and its real pipelines.
 *
 * Run by hand (`npx tsx scripts/delivery-loop/rehearse.ts`), never by CI. It exists to answer the one question the unit tests cannot: does
 * the loop work against GitLab as GitLab really behaves (label events, member levels, merge request pipelines, runner failures, job logs)?
 *
 * WHAT IS REAL: the GitLab REST client, the engine, the project, its issue, label events and member levels, its merge request pipelines,
 * its runner and the logs of its jobs, and the pipeline retry.
 * WHAT IS A STAND-IN, and is said so in the report: the OASIS ledger (in memory: no database is reachable from here), the executor (a
 * labelled stub worker that pushes a fix to the branch), the reviewer (a stub that answers a fixed verdict) and the memory (a recorder).
 *
 * GROUND RULES, enforced in code and not by promise:
 *   - one project only, the scratch project `vitana/rehearsal` (refused for any other);
 *   - every object it creates is named `loop-rehearsal-<run id>`, and it only ever touches objects it created (it remembers their ids);
 *   - it can never change `main`: the only writes it can make are NAMED operations (below), each takes a branch and refuses `main` by value,
 *     and there is no generic "send this body" call to get around that with spacing or another key name;
 *   - the transport is injected (the sandbox reaches GitLab through a proxy); it prints no token.
 */
import { createGitlabClient, type GitlabClient } from '../../services/gateway/src/services/delivery-loop/gitlab-client';

export const REHEARSAL_PROJECT = 'vitana/rehearsal';
export const PREFIX = 'loop-rehearsal-';
/** The prefix of the branches this rehearsal makes, in the form DELIVERY_LOOP_BRANCH_PREFIXES accepts (a trailing slash: a bare name prefix is refused on purpose). */
export const BRANCH_PREFIX = 'loop-rehearsal/';

export interface RehearsalTransport {
  baseUrl: string;
  fetch: typeof fetch;
  headers?: Record<string, string>;
  token: string;
}

export class Refused extends Error {}

const RESERVED: ReadonlySet<string> = new Set(['main', 'master', 'trunk', 'head', 'prod', 'production', 'staging', 'develop', 'release', 'test']);

const BRANCH_OK = (run: string) => new RegExp(`^${BRANCH_PREFIX}${run}(-[a-z0-9]+)*$`);

/**
 * The only writes the rehearsal can make. A branch name must be this run's own (`loop-rehearsal-<run>...`), which is never `main`, and
 * an object id must be one this run created. (`loop-rehearsal/<run>`: the slash is what makes it a prefix the loop's branch rule accepts.)
 */
export class Rehearsal {
  readonly branch: string;
  readonly created = { branches: new Set<string>(), mrs: new Set<number>(), issues: new Set<number>() };
  readonly log: string[] = [];

  constructor(private readonly t: RehearsalTransport, readonly run: string) {
    if (!/^[a-z0-9]{4,12}$/.test(run)) throw new Refused('a run id is 4 to 12 lowercase letters or digits');
    // A run id that is also the name of a branch people use would only confuse; the prefix keeps the branch safe, the id should too.
    if (RESERVED.has(run)) throw new Refused(`${run} is a reserved name, not a run id`);
    this.branch = `${BRANCH_PREFIX}${run}`;
  }

  get client(): GitlabClient {
    return createGitlabClient({ baseUrl: this.t.baseUrl, token: this.t.token, allowedProjects: [REHEARSAL_PROJECT], fetch: this.t.fetch, headers: this.t.headers, timeoutMs: 30_000 });
  }

  private async raw(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await this.t.fetch(`${this.t.baseUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(REHEARSAL_PROJECT)}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': this.t.token, ...(this.t.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep the text */
    }
    this.log.push(`${method} ${path.split('?')[0]} -> ${r.status}`);
    return { status: r.status, json };
  }

  private ownBranch(name: string): string {
    if (name === 'main' || !BRANCH_OK(this.run).test(name)) throw new Refused(`refused: ${name} is not a branch of this rehearsal run`);
    return name;
  }

  async projectIsPrivate(): Promise<boolean> {
    const r = await this.raw('GET', '');
    return r.status === 200 && r.json?.visibility === 'private' && r.json?.path_with_namespace === REHEARSAL_PROJECT;
  }

  /** Creates this run's branch from `main` (reading main, never writing it). */
  async createBranch(name = this.branch): Promise<void> {
    const b = this.ownBranch(name);
    const r = await this.raw('POST', '/repository/branches', { branch: b, ref: 'main' });
    if (r.status !== 201) throw new Error(`createBranch ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    this.created.branches.add(b);
  }

  /** One commit on this run's branch: create or update files. */
  async commit(branch: string, message: string, files: Record<string, string>): Promise<string> {
    const b = this.ownBranch(branch);
    const actions = [] as Array<{ action: 'create' | 'update'; file_path: string; content: string }>;
    for (const [file_path, content] of Object.entries(files)) {
      const exists = (await this.raw('GET', `/repository/files/${encodeURIComponent(file_path)}?ref=${encodeURIComponent(b)}`)).status === 200;
      actions.push({ action: exists ? 'update' : 'create', file_path, content });
    }
    const r = await this.raw('POST', '/repository/commits', { branch: b, commit_message: message, actions });
    if (r.status !== 201) throw new Error(`commit ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    return String(r.json.id);
  }

  async openMergeRequest(source: string, title: string, description: string, draft = false): Promise<number> {
    const s = this.ownBranch(source);
    const r = await this.raw('POST', '/merge_requests', { source_branch: s, target_branch: 'main', title: draft ? `Draft: ${title}` : title, description, remove_source_branch: true });
    if (r.status !== 201) throw new Error(`openMergeRequest ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    this.created.mrs.add(r.json.iid);
    return r.json.iid;
  }

  /**
   * Retries the failed jobs of a pipeline, but only one that ran on a merge request this run opened or on this run's own branch: the
   * pipeline is READ first and its `ref` decided by value (a merge request pipeline's ref is `refs/merge-requests/<iid>/head`). A
   * pipeline of `main`, of another run, of a tag, or of anyone's merge request is refused before any write. No body is sent.
   */
  async retryOwnPipeline(id: number): Promise<{ id: number; status: string }> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Refused(`refused: ${String(id)} is not a pipeline id`);
    const read = await this.raw('GET', `/pipelines/${id}`);
    if (read.status !== 200) throw new Error(`retryOwnPipeline: reading pipeline ${id} gave ${read.status}`);
    const ref = String(read.json?.ref ?? '');
    const mr = /^refs\/merge-requests\/(\d+)\/head$/.exec(ref);
    const mine = mr ? this.created.mrs.has(Number(mr[1])) : this.created.branches.has(ref) && BRANCH_OK(this.run).test(ref) && ref !== 'main';
    if (!mine) throw new Refused(`refused: pipeline ${id} ran on ${ref || 'no ref'}, which this run did not create`);
    // The write is the loop's own call (`GitlabClient.retryPipeline`), not a copy of it: what is proven live is the code the loop runs.
    const retried = await this.client.retryPipeline(REHEARSAL_PROJECT, id);
    this.log.push(`POST /pipelines/${id}/retry -> ${retried.ok ? 'ok' : retried.error} (the loop's own client)`);
    if (!retried.ok) throw new Error(`retryOwnPipeline: ${retried.error}`);
    return { id: retried.data.id, status: retried.data.status };
  }

  async openIssue(title: string, description: string, labels: string[]): Promise<number> {
    const r = await this.raw('POST', '/issues', { title: `${PREFIX}${this.run}: ${title}`, description, labels: labels.join(',') });
    if (r.status !== 201) throw new Error(`openIssue ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
    this.created.issues.add(r.json.iid);
    return r.json.iid;
  }

  async labelIssue(iid: number, add: string[]): Promise<void> {
    if (!this.created.issues.has(iid)) throw new Refused(`refused: issue #${iid} was not created by this run`);
    await this.raw('PUT', `/issues/${iid}`, { add_labels: add.join(',') });
  }

  /** Closes and deletes everything this run created. Best effort, never throws; returns what it could not remove. */
  async cleanup(): Promise<string[]> {
    const left: string[] = [];
    for (const iid of this.created.mrs) {
      const r = await this.raw('PUT', `/merge_requests/${iid}`, { state_event: 'close' });
      if (![200, 404].includes(r.status)) left.push(`mr !${iid} (${r.status})`);
    }
    for (const iid of this.created.issues) {
      const r = await this.raw('PUT', `/issues/${iid}`, { state_event: 'close' });
      if (![200, 404].includes(r.status)) left.push(`issue #${iid} (${r.status})`);
    }
    for (const b of this.created.branches) {
      const r = await this.raw('DELETE', `/repository/branches/${encodeURIComponent(this.ownBranch(b))}`);
      if (![204, 404].includes(r.status)) left.push(`branch ${b} (${r.status})`);
    }
    return left;
  }
}
