/**
 * VTID-04465 — the operator pipeline's one in-memory database, plus the one
 * in-memory GitHub, behind a single `fetch`.
 *
 * Builds on the support suite's FakePlatform (VTID-04456) — same tables, same
 * `insert()` defaults, same supabase-js `client()` — and replaces its PostgREST
 * `fetch` with a fuller one, because the Dev Autopilot code uses PostgREST
 * features the support pipeline never needed:
 *
 *   - JSON-path filters (`metadata->>claimed_env=is.null`,
 *     `spec_snapshot->>scanner=in.("a","b")`) — the env-ownership and
 *     PR-flood guards are written in them;
 *   - `not.in.(…)`, numeric `lte`, multi-column `order=a.desc.nullslast,b.asc`;
 *   - upserts (`on_conflict` + `resolution=merge-duplicates`), DELETE, and
 *   - RPC: `allocate_global_vtid` (the VTID allocator; emulated here the way
 *     the migration defines it — mint the number AND write the ledger shell
 *     row in one step). Every other RPC answers 404, exactly what PostgREST
 *     answers for a function that does not exist, so callers take their own
 *     documented fallback (e.g. local governance evaluation).
 *
 * One database-side rule is emulated because the pipeline relies on it and no
 * gateway code enforces it: the partial unique index
 * `dev_autopilot_executions_finding_inflight_uniq` (one in-flight execution per
 * finding). The suite checks the emulated status list against the migration.
 *
 * Filters are applied the way Postgres applies them: a comparison against NULL
 * is never true (so `neq`/`not.in` do not match a NULL column), only `is.null`
 * matches NULL. An operator this fake does not know is recorded in
 * {@link OperatorPlatform.unsupported} and treated as "match nothing", so a
 * missing feature shows up as a failed assertion, never as a silent pass.
 *
 * Every other URL (a provider, S3, a metadata server) is refused with 503 and
 * recorded in {@link OperatorPlatform.externalCalls}: no test can reach a real
 * network service through this fetch.
 */

import { createHash, randomUUID } from 'crypto';
import { FakePlatform, FAKE_SUPABASE_URL, type Row } from '../support-pipeline/fake-platform';

export { FAKE_SUPABASE_URL };
export type { Row };

/** The in-flight statuses the real partial unique index covers (migration 20260509000000). */
export const INFLIGHT_UNIQUE_STATUSES = ['cooling', 'running', 'ci', 'merging', 'deploying', 'verifying'] as const;

// ---------------------------------------------------------------------------
// PostgREST parsing
// ---------------------------------------------------------------------------

type Filter = { col: string; op: string; val: any };

function stripQuotes(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

function parseList(raw: string): string[] {
  return raw.replace(/^\(|\)$/g, '').split(',').map((x) => stripQuotes(x)).filter((x) => x.length > 0);
}

function parseFilter(col: string, raw: string): Filter {
  const neg = raw.startsWith('not.');
  const body = neg ? raw.slice(4) : raw;
  const dot = body.indexOf('.');
  const op = dot === -1 ? body : body.slice(0, dot);
  let val: any = dot === -1 ? '' : body.slice(dot + 1);
  if (op === 'in') val = parseList(String(val));
  else if (op === 'is') val = val === 'null' ? null : val === 'true' ? true : val === 'false' ? false : val;
  else if (op === 'cs' || op === 'cd') {
    const s = String(val);
    val = s.startsWith('{') && !s.includes(':') ? parseList(s.replace(/^\{|\}$/g, '')) : JSON.parse(s);
  } else val = stripQuotes(String(val));
  return { col, op: neg ? `not.${op}` : op, val };
}

/** `metadata->>claimed_env`, `spec_snapshot->scope->>scanner`, or a plain column. */
function readPath(row: Row, colPath: string): any {
  const parts = colPath.split(/(->>|->)/);
  let v: any = row[parts[0]];
  for (let i = 1; i < parts.length; i += 2) {
    const arrow = parts[i];
    const key = parts[i + 1];
    if (v === null || v === undefined || typeof v !== 'object') return null;
    v = (v as Record<string, unknown>)[key];
    if (v === undefined) v = null;
    if (arrow === '->>' && v !== null) v = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return v === undefined ? null : v;
}

function isNumeric(v: unknown): boolean {
  return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim()));
}

function compare(a: unknown, b: unknown): number {
  if (isNumeric(a) && isNumeric(b)) return Number(a) - Number(b);
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function likeToRegex(pattern: string, ci: boolean): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/%/g, '.*');
  return new RegExp(`^${esc}$`, ci ? 'is' : 's');
}

export class OperatorPlatform extends FakePlatform {
  /** Filter operators or query features this fake does not implement. */
  readonly unsupported: string[] = [];
  /** Requests to anything that is neither the fake database nor the fake GitHub. */
  readonly externalCalls: Array<{ method: string; url: string }> = [];
  /** RPC calls, in order. */
  readonly rpcCalls: Array<{ name: string; args: Record<string, any> }> = [];
  private vtidSeq = 4700;
  private inflight = 0;
  private callCount = 0;

  constructor(readonly github: FakeGitHub = new FakeGitHub()) {
    super({});
  }

  override insert(table: string, input: Row): Row {
    const row = super.insert(table, input);
    if (table === 'dev_autopilot_executions') {
      for (const [k, v] of Object.entries({
        metadata: {}, status: 'queued', branch: null, pr_url: null, pr_number: null, triage_report: null,
        parent_execution_id: null, auto_fix_depth: 0, completed_at: null, execution_session_id: null,
        failure_stage: null, self_healing_vtid: null, revert_pr_url: null, cancelled_at: null,
      })) if (row[k] === undefined) row[k] = v;
    }
    if (table === 'autopilot_recommendations') {
      for (const [k, v] of Object.entries({ status: 'new', risk_class: null, spec_snapshot: {}, source_ref: null, impact_score: null, effort_score: null }))
        if (row[k] === undefined) row[k] = v;
    }
    if (table === 'vtid_ledger') {
      for (const [k, v] of Object.entries({ is_terminal: false, terminal_outcome: null, metadata: {}, spec_status: 'draft', status: 'allocated' }))
        if (row[k] === undefined) row[k] = v;
    }
    if (table === 'oasis_events') {
      if (row.metadata === undefined) row.metadata = {};
    }
    return row;
  }

  // ---- helpers the suite reads -------------------------------------------

  rows(table: string): Row[] {
    return this.table(table);
  }

  execution(id: string): Row {
    const r = this.table('dev_autopilot_executions').find((e) => e.id === id);
    if (!r) throw new Error(`operator-platform: no execution ${id}`);
    return r;
  }

  ledger(vtid: string): Row {
    const r = this.table('vtid_ledger').find((e) => e.vtid === vtid);
    if (!r) throw new Error(`operator-platform: no vtid_ledger row ${vtid}`);
    return r;
  }

  events(topic?: string | RegExp): Row[] {
    const all = this.table('oasis_events');
    if (!topic) return all;
    return all.filter((e) => (typeof topic === 'string' ? e.topic === topic : topic.test(String(e.topic))));
  }

  /** Every fetch in flight has settled and nothing new started for a few rounds. */
  async settle(maxMs = 10_000): Promise<void> {
    const realSetTimeout = globalThis.setTimeout;
    const started = Date.now();
    let quiet = 0;
    let lastCount = -1;
    while (Date.now() - started < maxMs) {
      await new Promise((r) => realSetTimeout(r, 5));
      if (this.inflight === 0 && this.callCount === lastCount) {
        quiet += 1;
        if (quiet >= 6) return;
      } else {
        quiet = 0;
      }
      lastCount = this.callCount;
    }
    throw new Error(`operator-platform: did not settle within ${maxMs} ms (in flight: ${this.inflight})`);
  }

  // ---- the one fetch -------------------------------------------------------

  readonly router = async (input: any, init: any = {}): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    this.inflight += 1;
    this.callCount += 1;
    try {
      // Let every caller's own `await` interleave like a real network hop.
      await Promise.resolve();
      if (url.origin === new URL(FAKE_SUPABASE_URL).origin && url.pathname.startsWith('/rest/v1/')) {
        return this.rest(url, method, init);
      }
      if (url.hostname === 'api.github.com') {
        return this.github.handle(method, url, init.body ? JSON.parse(String(init.body)) : undefined);
      }
      this.externalCalls.push({ method, url: `${url.origin}${url.pathname}` });
      return new Response('network disabled in the operator pipeline suite', { status: 503 });
    } finally {
      this.inflight -= 1;
    }
  };

  private headerMap(init: any): Record<string, string> {
    const out: Record<string, string> = {};
    const h = init && init.headers;
    if (!h) return out;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      h.forEach((v, k) => { out[k.toLowerCase()] = v; });
      return out;
    }
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
    return out;
  }

  private rest(url: URL, method: string, init: any): Response {
    const path = url.pathname.slice('/rest/v1/'.length);
    const headers = this.headerMap(init);
    const prefer = headers.prefer || '';
    const bodyText = init.body ? String(init.body) : '';

    if (path.startsWith('rpc/')) {
      const name = path.slice(4);
      const args = bodyText ? JSON.parse(bodyText) : {};
      this.rpcCalls.push({ name, args });
      return this.rpc(name, args);
    }
    const table = path;
    this.restCalls.push({ method, table, query: url.search });

    const filters: Filter[] = [];
    let select: string | null = null;
    let limit: number | null = null;
    let offset = 0;
    let order: Array<{ col: string; desc: boolean; nullsFirst: boolean }> = [];
    let onConflict: string[] | null = null;
    for (const [key, raw] of url.searchParams.entries()) {
      if (key === 'select') { select = raw; continue; }
      if (key === 'limit') { limit = Number(raw); continue; }
      if (key === 'offset') { offset = Number(raw); continue; }
      if (key === 'on_conflict') { onConflict = raw.split(',').map((c) => c.trim()); continue; }
      if (key === 'columns') continue;
      if (key === 'order') {
        order = raw.split(',').map((part) => {
          const bits = part.split('.');
          const desc = bits.includes('desc');
          const nullsFirst = bits.includes('nullsfirst') ? true : bits.includes('nullslast') ? false : desc;
          return { col: bits[0], desc, nullsFirst };
        });
        continue;
      }
      if (key === 'or' || key === 'and' || key === 'not.or' || key === 'not.and') {
        this.unsupported.push(`${table}: logic tree ${key}=${raw}`);
        filters.push({ col: key, op: '__unsupported__', val: raw });
        continue;
      }
      filters.push(parseFilter(key, raw));
    }

    const wantsRows = prefer.includes('return=representation');

    if (method === 'GET' || method === 'HEAD') {
      let rows = this.where(table, filters);
      const total = rows.length;
      if (order.length) rows = this.sort(rows, order);
      rows = rows.slice(offset, limit != null ? offset + limit : undefined);
      const out = rows.map((r) => this.project(r, select));
      return this.json(200, method === 'HEAD' ? undefined : out, { 'Content-Range': `${offset}-${offset + out.length - 1}/${total}` });
    }
    if (method === 'PATCH') {
      const patch = bodyText ? JSON.parse(bodyText) : {};
      const rows = this.where(table, filters);
      const conflict = this.inflightConflict(table, rows.map((r) => ({ ...r, ...patch })), new Set(rows.map((r) => r.id)));
      if (conflict) return conflict;
      const now = new Date().toISOString();
      for (const r of rows) Object.assign(r, patch, { updated_at: now });
      return wantsRows ? this.json(200, rows.map((r) => this.project(r, select))) : this.json(204, undefined);
    }
    if (method === 'POST') {
      const parsed = bodyText ? JSON.parse(bodyText) : {};
      const bodies: Row[] = Array.isArray(parsed) ? parsed : [parsed];
      const merge = prefer.includes('resolution=merge-duplicates');
      const ignore = prefer.includes('resolution=ignore-duplicates');
      const out: Row[] = [];
      for (const b of bodies) {
        const keyCols = onConflict || (b.id ? ['id'] : null);
        const existing = keyCols
          ? this.table(table).find((r) => keyCols.every((c) => r[c] !== undefined && String(r[c]) === String(b[c])))
          : undefined;
        if (existing) {
          if (merge) { Object.assign(existing, b, { updated_at: new Date().toISOString() }); out.push(existing); continue; }
          if (ignore) continue;
          return this.json(409, { code: '23505', message: `duplicate key value violates unique constraint on ${table}` });
        }
        const conflict = this.inflightConflict(table, [b], new Set());
        if (conflict) return conflict;
        out.push(this.insert(table, b));
      }
      return wantsRows ? this.json(201, out.map((r) => this.project(r, select))) : this.json(201, undefined);
    }
    if (method === 'DELETE') {
      const rows = new Set(this.where(table, filters));
      const kept = this.table(table).filter((r) => !rows.has(r));
      this.table(table).length = 0;
      this.table(table).push(...kept);
      return wantsRows ? this.json(200, [...rows].map((r) => this.project(r, select))) : this.json(204, undefined);
    }
    this.unsupported.push(`${table}: method ${method}`);
    return this.json(405, { message: `method ${method} not supported by the fake` });
  }

  /** dev_autopilot_executions_finding_inflight_uniq, emulated. */
  private inflightConflict(table: string, candidates: Row[], excludeIds: Set<string>): Response | null {
    if (table !== 'dev_autopilot_executions') return null;
    for (const c of candidates) {
      if (!(INFLIGHT_UNIQUE_STATUSES as readonly string[]).includes(c.status)) continue;
      const clash = this.table(table).find((r) => r.finding_id === c.finding_id && r.id !== c.id && !excludeIds.has(r.id)
        && (INFLIGHT_UNIQUE_STATUSES as readonly string[]).includes(r.status));
      if (clash) {
        return this.json(409, {
          code: '23505',
          message: 'duplicate key value violates unique constraint "dev_autopilot_executions_finding_inflight_uniq"',
        });
      }
    }
    return null;
  }

  private where(table: string, filters: Filter[]): Row[] {
    return this.table(table).filter((r) => filters.every((f) => this.matches(table, r, f)));
  }

  private matches(table: string, row: Row, f: Filter): boolean {
    const v = readPath(row, f.col);
    const isNull = v === null || v === undefined;
    switch (f.op) {
      case 'eq': return !isNull && String(v) === String(f.val);
      case 'neq': return !isNull && String(v) !== String(f.val);
      case 'in': return !isNull && (f.val as string[]).includes(String(v));
      case 'not.in': return !isNull && !(f.val as string[]).includes(String(v));
      case 'is': return f.val === null ? isNull : v === f.val;
      case 'not.is': return f.val === null ? !isNull : v !== f.val;
      case 'gt': return !isNull && compare(v, f.val) > 0;
      case 'gte': return !isNull && compare(v, f.val) >= 0;
      case 'lt': return !isNull && compare(v, f.val) < 0;
      case 'lte': return !isNull && compare(v, f.val) <= 0;
      case 'like': return typeof v === 'string' && likeToRegex(String(f.val), false).test(v);
      case 'ilike': return typeof v === 'string' && likeToRegex(String(f.val), true).test(v);
      case 'not.ilike': return !(typeof v === 'string' && likeToRegex(String(f.val), true).test(v));
      case 'cs': {
        if (Array.isArray(v)) return (Array.isArray(f.val) ? f.val : [f.val]).every((x: unknown) => v.map(String).includes(String(x)));
        if (v && typeof v === 'object' && f.val && typeof f.val === 'object') {
          return Object.entries(f.val).every(([k, x]) => JSON.stringify((v as Record<string, unknown>)[k]) === JSON.stringify(x));
        }
        return false;
      }
      default:
        this.unsupported.push(`${table}: operator ${f.op} on ${f.col}`);
        return false;
    }
  }

  private sort(rows: Row[], order: Array<{ col: string; desc: boolean; nullsFirst: boolean }>): Row[] {
    return [...rows].sort((a, b) => {
      for (const o of order) {
        const va = readPath(a, o.col);
        const vb = readPath(b, o.col);
        const na = va === null || va === undefined;
        const nb = vb === null || vb === undefined;
        if (na && nb) continue;
        if (na) return o.nullsFirst ? -1 : 1;
        if (nb) return o.nullsFirst ? 1 : -1;
        const c = compare(va, vb);
        if (c !== 0) return o.desc ? -c : c;
      }
      return 0;
    });
  }

  private project(row: Row, select: string | null): Row {
    if (!select || select.trim() === '*') return JSON.parse(JSON.stringify(row));
    const out: Row = {};
    let depth = 0;
    let cur = '';
    const items: string[] = [];
    for (const ch of select) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { items.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur) items.push(cur);
    for (const rawItem of items) {
      const item = rawItem.trim();
      if (!item || item.includes('(')) continue; // embedded resources are not used by the pipeline
      if (item === '*') { Object.assign(out, JSON.parse(JSON.stringify(row))); continue; }
      const [alias, col] = item.includes(':') ? item.split(':') : [null, item];
      const key = alias || col.split(/->>|->/).pop()!;
      const v = readPath(row, col);
      out[key] = v === undefined ? null : JSON.parse(JSON.stringify(v));
    }
    return out;
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    if (body === undefined || status === 204) return new Response(null, { status, headers });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  private rpc(name: string, args: Record<string, any>): Response {
    if (name === 'allocate_global_vtid') {
      this.vtidSeq += 1;
      const vtid = `VTID-${String(this.vtidSeq).padStart(5, '0')}`;
      const row = this.insert('vtid_ledger', {
        vtid,
        title: 'Allocated - Pending Title',
        status: 'allocated',
        spec_status: 'draft',
        is_terminal: false,
        metadata: { source: args.p_source, layer: args.p_layer, module: args.p_module },
      });
      return this.json(200, [{ vtid, num: this.vtidSeq, id: row.id }]);
    }
    return this.json(404, { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` });
  }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface FakePr {
  number: number;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  state: 'open' | 'closed';
  merged: boolean;
  merge_commit_sha: string | null;
  html_url: string;
}

export interface FakeCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | null;
  details_url: string;
}

/**
 * The repo the agent clones and pushes to, and the REST API the watcher,
 * approval route and bridge call. Pushes, PRs, merges and closes are recorded
 * so a scenario can assert "exactly one PR" or "nothing was pushed".
 */
export class FakeGitHub {
  readonly repo = 'exafyltd/vitana-platform';
  readonly commits = new Map<string, Record<string, string>>();
  readonly branches = new Map<string, string>();
  readonly prs = new Map<number, FakePr>();
  readonly checks = new Map<string, FakeCheckRun[]>();
  readonly jobLogs = new Map<number, string>();
  readonly pushes: Array<{ branch: string; sha: string; force: boolean; files: string[] }> = [];
  readonly calls: Array<{ method: string; path: string }> = [];
  readonly deletedBranches: string[] = [];
  private nextPr = 3600;
  private nextCheck = 900;

  constructor(mainFiles: Record<string, string> = {}) {
    const sha = this.commit(mainFiles);
    this.branches.set('main', sha);
  }

  commit(files: Record<string, string>): string {
    const sha = createHash('sha1').update(JSON.stringify(files) + randomUUID()).digest('hex');
    this.commits.set(sha, { ...files });
    return sha;
  }

  headOf(branch: string): string {
    const sha = this.branches.get(branch);
    if (!sha) throw new Error(`fake-github: no branch ${branch}`);
    return sha;
  }

  filesAt(shaOrBranch: string): Record<string, string> {
    const sha = this.branches.get(shaOrBranch) ?? shaOrBranch;
    const f = this.commits.get(sha);
    if (!f) throw new Error(`fake-github: no commit ${shaOrBranch}`);
    return f;
  }

  push(branch: string, files: Record<string, string>, force: boolean): string {
    const before = this.branches.get(branch);
    const sha = this.commit(files);
    this.branches.set(branch, sha);
    const prev = before ? this.commits.get(before) || {} : this.filesAt('main');
    const changed = Object.keys({ ...prev, ...files }).filter((p) => prev[p] !== files[p]).sort();
    this.pushes.push({ branch, sha, force, files: changed });
    for (const pr of this.prs.values()) if (pr.head.ref === branch && pr.state === 'open') pr.head.sha = sha;
    return sha;
  }

  prForBranch(branch: string): FakePr | undefined {
    return [...this.prs.values()].find((p) => p.head.ref === branch);
  }

  /** Report CI for a commit: every name passes unless listed in `failing`. */
  setChecks(sha: string, names: string[], failing: string[] = []): void {
    this.checks.set(sha, names.map((name) => {
      const id = ++this.nextCheck;
      if (failing.includes(name)) this.jobLogs.set(id, `##[group]Run ${name}\nFAIL test/greeting.test.ts\n  ● greets by name\n    expected "Hello, Ada" received "Hello, undefined"\n##[error]Process completed with exit code 1.`);
      return {
        id,
        name,
        status: 'completed' as const,
        conclusion: failing.includes(name) ? 'failure' as const : 'success' as const,
        details_url: `https://github.com/${this.repo}/actions/runs/77/job/${id}`,
      };
    }));
  }

  private mergeableState(pr: FakePr): string {
    if (pr.merged || pr.state === 'closed') return 'unknown';
    const runs = this.checks.get(pr.head.sha) || [];
    if (runs.length === 0) return 'unknown';
    if (runs.some((r) => r.conclusion === 'failure')) return 'blocked';
    if (runs.every((r) => r.status === 'completed' && r.conclusion === 'success')) return 'clean';
    return 'unstable';
  }

  private res(status: number, body?: unknown): Response {
    if (body === undefined) return new Response(null, { status });
    if (typeof body === 'string') return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  handle(method: string, url: URL, body: any): Response {
    const path = url.pathname;
    this.calls.push({ method, path });
    const prefix = `/repos/${this.repo}`;
    if (!path.startsWith(prefix)) return this.res(404, { message: `fake-github: unknown repo in ${path}` });
    const rest = path.slice(prefix.length);
    let m: RegExpExecArray | null;

    if (method === 'POST' && rest === '/pulls') {
      if (!this.branches.has(body.head)) return this.res(422, { message: `fake-github: head ${body.head} was never pushed` });
      if (this.prForBranch(body.head)?.state === 'open') return this.res(422, { message: 'A pull request already exists for this branch' });
      const number = ++this.nextPr;
      const pr: FakePr = {
        number, title: body.title, body: body.body, head: { ref: body.head, sha: this.headOf(body.head) }, base: { ref: body.base || 'main' },
        state: 'open', merged: false, merge_commit_sha: null, html_url: `https://github.com/${this.repo}/pull/${number}`,
      };
      this.prs.set(number, pr);
      return this.res(201, { number, html_url: pr.html_url, state: 'open' });
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
      const pr = this.prs.get(Number(m[1]));
      if (!pr) return this.res(404, { message: 'Not Found' });
      if (method === 'GET') return this.res(200, { ...pr, mergeable_state: this.mergeableState(pr) });
      if (method === 'PATCH') {
        if (body && body.state === 'closed') pr.state = 'closed';
        return this.res(200, { ...pr });
      }
    }
    if ((m = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && method === 'PUT') {
      const pr = this.prs.get(Number(m[1]));
      if (!pr || pr.state !== 'open') return this.res(405, { message: 'Pull Request is not mergeable' });
      const files = { ...this.filesAt('main'), ...this.filesAt(pr.head.sha) };
      const sha = this.commit(files);
      this.branches.set('main', sha);
      pr.merged = true;
      pr.state = 'closed';
      pr.merge_commit_sha = sha;
      return this.res(200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
    if ((m = /^\/pulls\/(\d+)\/update-branch$/.exec(rest)) && method === 'PUT') {
      return this.res(202, { message: 'Updating pull request branch.' });
    }
    if ((m = /^\/commits\/([0-9a-f]+)\/status$/.exec(rest)) && method === 'GET') {
      return this.res(200, { state: 'success', statuses: [] });
    }
    if ((m = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest)) && method === 'GET') {
      return this.res(200, { total_count: (this.checks.get(m[1]) || []).length, check_runs: this.checks.get(m[1]) || [] });
    }
    if ((m = /^\/compare\/(.+)\.\.\.(.+)$/.exec(rest)) && method === 'GET') {
      return this.res(200, { behind_by: 0, ahead_by: 1, status: 'ahead' });
    }
    if ((m = /^\/actions\/jobs\/(\d+)\/logs$/.exec(rest)) && method === 'GET') {
      const log = this.jobLogs.get(Number(m[1]));
      return log ? this.res(200, log) : this.res(404, { message: 'Not Found' });
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'DELETE') {
      const branch = decodeURIComponent(m[1]);
      this.deletedBranches.push(branch);
      this.branches.delete(branch);
      return this.res(204);
    }
    return this.res(404, { message: `fake-github: ${method} ${rest} is not emulated` });
  }
}
