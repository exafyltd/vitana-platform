/**
 * VTID-05274 — Gate 2 from the Project Manager (plan kiro-autonomy-fallback §5 C5).
 *
 * `RunViewGate2EvidenceResolver` builds the owner's Gate 2 evidence from the
 * same sources the Operator Console run view reads (services/operator-runs/
 * run-view.ts deps: STAGING-VERIFY events, production build-info, the commit
 * range): per service the verified and production commits, every commit in
 * between, each STAGING-VERIFY run link with test counts, the migrations in the
 * release, the lanes' "Decisions taken" and the plan's timings. Every source
 * fails open into `unavailable[]` (run-view posture).
 *
 * `OperatorChatGate2Poster` posts ONE assistant message with the existing
 * question to the Operator Chat thread linked to the plan's VTIDs (else a PM
 * thread `pm-gate2-<slug>`), and records a `pm_digests` `gate2_batch` row so the
 * observer sees `gate2_sent` next tick. Posting only — no deploy capability
 * exists here. (The OASIS `pm.*` topic is not in the closed CicdEventType union,
 * which lives outside this lane; pm_digests is the observable record.)
 */
import type { Gate2EvidenceResolver, Gate2Message, Gate2Poster } from './act';
import type { Gate2Decision, Gate2Evidence, ObservedState, PlanTimings } from './types';
import { planTimings } from './timings';
import { gh, supaRest } from './github-rest';

type Service = 'gateway' | 'community-app';
const REPO_OF: Record<Service, string> = { gateway: 'exafyltd/vitana-platform', 'community-app': 'exafyltd/vitana-v1' };

/** The subset of a STAGING-VERIFY OASIS record the evidence needs (run-view `VerifyEvent`). */
export interface Gate2VerifyEvent {
  topic: string;
  created_at: string;
  service: string | null;
  commit: string | null;
  production_commit: string | null;
  run_url: string | null;
  vtids: string[];
  results: Array<{ ok?: boolean }>;
}

export interface Gate2SourceDeps {
  productionCommit(service: Service): Promise<string | null>;
  verifyEvents(vtids: string[]): Promise<Gate2VerifyEvent[]>;
  commitsBetween(repo: string, base: string, head: string): Promise<Array<{ sha: string; message: string }>>;
  /** Files changed in base...head (for the migrations list). */
  changedFiles?(repo: string, base: string, head: string): Promise<string[]>;
}

function errName(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 120);
}

export class RunViewGate2EvidenceResolver implements Gate2EvidenceResolver {
  constructor(private readonly deps: Gate2SourceDeps, private readonly now: () => number = Date.now) {}

  async resolve(decision: Gate2Decision, state: ObservedState): Promise<Gate2Evidence> {
    const unavailable: string[] = [];
    let events: Gate2VerifyEvent[] = [];
    try {
      events = await this.deps.verifyEvents(decision.vtids);
    } catch (e) {
      unavailable.push(`staging_verify:${errName(e)}`);
    }
    const passed = events
      .filter((e) => e.topic === 'staging.verify.passed' && e.vtids.some((v) => decision.vtids.includes(v)))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    const services: NonNullable<Gate2Evidence['services']> = [];
    const commits: string[] = [];
    const migrations: string[] = [];
    for (const service of ['gateway', 'community-app'] as Service[]) {
      const ev = passed.find((e) => (e.service ?? 'gateway') === service);
      if (!ev || !ev.commit) continue;
      const repo = REPO_OF[service];
      let prod: string | null = null;
      try {
        prod = await this.deps.productionCommit(service);
      } catch {
        unavailable.push(`production_commit:${service}`);
        prod = ev.production_commit;
      }
      services.push({ service, repo, verified_commit: ev.commit, production_commit: prod });
      if (!prod) {
        unavailable.push(`commits:${service}`);
        continue;
      }
      try {
        commits.push(...(await this.deps.commitsBetween(repo, prod, ev.commit)).map((c) => c.sha));
      } catch {
        unavailable.push(`commits:${service}`);
      }
      if (service === 'gateway' && this.deps.changedFiles) {
        try {
          migrations.push(...(await this.deps.changedFiles(repo, prod, ev.commit)).filter((f) => f.startsWith('supabase/migrations/')));
        } catch {
          unavailable.push('migrations');
        }
      }
    }

    const staging_verify = passed.map((e) => {
      const total = e.results.length;
      return {
        service: e.service ?? 'gateway',
        run_url: e.run_url,
        passed: total ? e.results.filter((r) => r.ok === true).length : null,
        failed: total ? e.results.filter((r) => r.ok === false).length : null,
        total: total || null,
      };
    });

    const lanes = state.lanes.filter((l) => l.slug === decision.slug);
    const decisions_taken = lanes.flatMap((l) => (l.decisions_taken ?? []).map((d) => `${l.lane}: ${d}`));
    const timings: PlanTimings = planTimings(
      {
        plan_slug: decision.slug,
        vtid: lanes.find((l) => l.vtid)?.vtid ?? decision.vtids[0] ?? '',
        vtids: lanes.map((l) => l.vtid).filter((v): v is string => !!v),
        generated_by: 'pm-agent',
        plan_pr_opened_at: null,
        converged_at: null,
        policy_approved_at: null,
        vtids_allocated_at: null,
        plan_merged_at: null,
        gate2_sent_at: new Date(this.now()).toISOString(),
        lanes: lanes.map((l) => ({
          lane: l.lane, vtid: l.vtid ?? '', claimed_at: l.claimed_at, pr_opened_at: null, accepted_at: null,
          merged_at: null, staging_verified_at: l.staging_verified_at, review_rounds: null, ci_fix_attempts: null,
        })),
        merge_conflict_count: null,
        staging_verify_failure_count: events.filter((e) => e.topic === 'staging.verify.failed').length,
      },
      new Date(this.now()).toISOString(),
    );

    const first = services[0];
    if (!first) unavailable.push('verified_commit');
    return {
      verified_commit: first?.verified_commit ?? '',
      production_commit: first?.production_commit ?? '',
      commits,
      services,
      staging_verify,
      migrations,
      decisions_taken,
      timings,
      unavailable,
    };
  }
}

const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : 'unknown');
const mins = (n: number | null) => (n == null ? 'n/a' : `${Math.round(n / 60000)} min`);

/** The Operator Chat text: the question first, then the machine evidence. Admin-facing, English by design. */
export function renderGate2Message(m: Gate2Message): string {
  const e = m.evidence;
  const lines: string[] = [m.question, '', `Plan ${m.slug} — ${m.vtids.join(', ')}`];
  for (const s of e.services ?? []) lines.push(`- ${s.service}: verified ${short(s.verified_commit)}, production ${short(s.production_commit)}`);
  lines.push('', 'STAGING-VERIFY:');
  for (const v of e.staging_verify ?? []) {
    lines.push(`- ${v.service}: ${v.run_url ?? 'run link unavailable'} (${v.passed ?? '?'} passed / ${v.failed ?? '?'} failed / ${v.total ?? '?'} total)`);
  }
  lines.push('', `Commits production → verified (${e.commits.length}):`);
  for (const c of e.commits) lines.push(`- ${c}`);
  lines.push('', `Migrations in the release: ${e.migrations && e.migrations.length ? '' : 'none'}`);
  for (const f of e.migrations ?? []) lines.push(`- ${f}`);
  lines.push('', 'Decisions taken:');
  for (const d of e.decisions_taken ?? []) lines.push(`- ${d}`);
  if (!e.decisions_taken || e.decisions_taken.length === 0) lines.push('- none recorded');
  if (e.timings) {
    lines.push('', `Timings: approved → verified ${mins(e.timings.approved_to_verified_ms)}, last merge → verified ${mins(e.timings.staging_verify_ms)}`);
  }
  if (e.unavailable && e.unavailable.length) lines.push('', `Unavailable: ${e.unavailable.join(', ')}`);
  return lines.join('\n');
}

/** Where the Gate 2 message and its record are written. */
export interface Gate2Store {
  /** The Operator Chat thread linked to any of the VTIDs (operator.kiro.* events), or null. */
  threadForVtids(vtids: string[]): Promise<string | null>;
  ensureThread(id: string, title: string): Promise<void>;
  insertMessage(threadId: string, content: string, meta: Record<string, unknown>): Promise<void>;
  insertDigest(payload: Record<string, unknown>): Promise<void>;
}

export class OperatorChatGate2Poster implements Gate2Poster {
  constructor(private readonly store: Gate2Store, private readonly now: () => number = Date.now) {}

  async post(m: Gate2Message): Promise<void> {
    let thread = await this.store.threadForVtids(m.vtids);
    if (!thread) {
      thread = `pm-gate2-${m.slug}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
      await this.store.ensureThread(thread, `Gate 2 — ${m.slug}`);
    }
    await this.store.insertMessage(thread, renderGate2Message(m), { source: 'pm-agent', kind: 'gate2', slug: m.slug, vtids: m.vtids });
    await this.store.insertDigest({
      slug: m.slug,
      vtids: m.vtids,
      verified_commit: m.evidence.verified_commit,
      thread_id: thread,
      sent_at: new Date(this.now()).toISOString(),
    });
  }
}

const enc = encodeURIComponent;

/** Production `Gate2Store` on Supabase REST (service role). */
export class SupabaseGate2Store implements Gate2Store {
  async threadForVtids(vtids: string[]): Promise<string | null> {
    const ok = vtids.filter((v) => /^VTID-\d{5}$/.test(v));
    if (!ok.length) return null;
    const rows = await supaRest<Array<{ metadata: Record<string, unknown> | null }>>(
      `/rest/v1/oasis_events?topic=in.(operator.kiro.branch_pushed,operator.kiro.write_tool_called)&metadata->>for_vtid=in.(${ok.map(enc).join(',')})&select=metadata&order=created_at.desc&limit=20`,
    );
    for (const r of rows) {
      const t = r.metadata?.thread_id;
      if (typeof t === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(t)) return t;
    }
    return null;
  }

  async ensureThread(id: string, title: string): Promise<void> {
    const rows = await supaRest<Array<{ id: string }>>(`/rest/v1/operator_threads?id=eq.${enc(id)}&select=id&limit=1`);
    if (rows.length) return;
    const now = new Date().toISOString();
    await supaRest(`/rest/v1/operator_threads`, {
      method: 'POST',
      body: JSON.stringify({ id, title, turns: 0, created_at: now, updated_at: now, last_message_at: now }),
    });
  }

  async insertMessage(threadId: string, content: string, meta: Record<string, unknown>): Promise<void> {
    await supaRest(`/rest/v1/operator_messages`, {
      method: 'POST',
      body: JSON.stringify([{ thread_id: threadId, role: 'assistant', tool_name: null, content, meta }]),
    });
  }

  async insertDigest(payload: Record<string, unknown>): Promise<void> {
    await supaRest(`/rest/v1/pm_digests`, { method: 'POST', body: JSON.stringify({ kind: 'gate2_batch', mode: 'live', payload }) });
  }
}

/** Production `Gate2SourceDeps` on the run-view deps plus a compare call for changed files. */
export function liveGate2SourceDeps(): Gate2SourceDeps {
  // Lazy: run-view pulls in the GitHub service and Supabase helpers.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const rv = require('../operator-runs/run-view') as typeof import('../operator-runs/run-view');
  const d = rv.liveRunViewDeps();
  return {
    productionCommit: (s) => d.productionCommit(s),
    async verifyEvents(vtids) {
      const all = await Promise.all(vtids.map((v) => d.loadVerifyEvents(v, [])));
      return all.flat();
    },
    commitsBetween: (repo, base, head) => d.commitsBetween(repo, base, head),
    async changedFiles(repo, base, head) {
      const r = await gh<{ files?: Array<{ filename: string }> }>(repo, `compare/${enc(base)}...${enc(head)}`);
      return (r.data?.files ?? []).map((f) => f.filename);
    },
  };
}
