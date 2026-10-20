#!/usr/bin/env node
/**
 * VTID-05214 — CI sparring for plan PRs (PLAN-SPAR.yml). Kiro has no gateway credential, so a plan's sparring runs
 * here: this script reads the PR head's files as DATA (it is run from the base branch's checkout, never from the PR),
 * calls the gateway sparring API with the service token, and writes the partner's rounds back into the spec folder for
 * the workflow to commit (`Collab-Session: ci-plan-spar`). The planner answers in `sparring/responses-<n>.md`; its
 * next push starts the next round.
 *
 *   node scripts/collab/plan-spar.mjs --dir <PR head checkout> --base-sha <sha> --repo exafyltd/vitana-platform \
 *        --changed <file with changed paths> [--summary <file>] [--extra-ref-vitana-v1 <vitana-v1 commit sha>]
 *   --extra-ref-vitana-v1 (optional): a 40-hex vitana-v1 commit; forwarded as extra_refs so the partner can
 *     read exafyltd/vitana-v1 (native plans premise on apps/mobile/** there). Omitted/invalid ⇒ unchanged.
 *   env: GATEWAY_URL, GATEWAY_SERVICE_TOKEN, PLAN_SPAR_ALLOCATE ("true" to allocate VTIDs after policy approval)
 *
 * Files under `.kiro/specs/<slug>/`:
 *   plan.md                      the plan; the text between <!-- plan:begin --> and <!-- plan:end --> is sparred
 *   sparring/state.json          written here: sessions, rounds seen, responses submitted
 *   sparring/round-<n>.md        written here: the partner's round n, verbatim (findings, acknowledgements)
 *   sparring/responses-<n>.md    written by the planner: one ```json [...] block — [{finding_id, disposition, rationale, deferred_to?}]
 *   sparring/verdict.md          written here when the plan converged (policy-approved) or was parked
 * Up to 2 sparring sessions per plan (the second is the re-plan after an escalation); a second escalation parks the
 * plan. A partner/model/code-access failure is not a plan problem: the plan goes to `next_actor: claude`, never parked.
 * VTID-05273: with allocation on, every later run on a converged, policy-approved plan allocates the lanes still
 * lacking a VTID (late lanes, a failed allocation) — idempotent per lane, sparring id sent at most once per session.
 * Exit codes: 0 done or nothing to do, 1 failure, 2 usage.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter } from './queue.mjs';

export const POLICY = 'converged-auto-v1';
export const MAX_SESSIONS = 2;
// Partner-side failures (not a plan problem): the plan goes to Claude, never parked. Only the gateway's own
// RETRYABLE_REASONS (plan-sparring-service.ts) are re-run automatically; anything else waits for Claude Code.
const INFRA_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded', 'partner_output_invalid'];
const RETRYABLE_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded'];
const POLL_MS = 20_000;
const WAIT_MS = 25 * 60_000;

class Usage extends Error {}

/** The one spec a plan PR is about: `.kiro/specs/<slug>/plan.md` or a responses file changed. */
export function detectSlug(changedPaths) {
  const slugs = new Set();
  for (const p of changedPaths) {
    const m = /^\.kiro\/specs\/([a-z0-9][a-z0-9-]*)\/(plan\.md|sparring\/(?:s\d+-)?responses-\d+\.md)$/.exec(p.trim());
    if (m) slugs.add(m[1]);
  }
  if (slugs.size > 1) throw new Usage(`one plan per PR: ${[...slugs].join(', ')}`);
  return slugs.size ? [...slugs][0] : null;
}

/** `[...]` from the first ```json block of a responses file. */
export function parseResponses(md) {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(md || '');
  if (!m) throw new Error('responses file has no ```json block');
  const v = JSON.parse(m[1]);
  if (!Array.isArray(v)) throw new Error('responses json must be an array');
  return v;
}

export function renderRound(session, round, prefix = '') {
  const r = session.rounds.find((x) => x.round === round);
  const lines = [`# Sparring round ${round} — ${session.verdict}`, '', `Session: \`${session.id}\` · plan hash \`${r?.plan_hash ?? ''}\``, ''];
  if (r?.partner_error) lines.push(`**Partner error:** ${r.partner_error}`, '');
  const rv = r?.review;
  if (rv) {
    lines.push('## Summary', '', rv.summary || '', '', '## Findings', '');
    if (!rv.findings?.length) lines.push('_none_');
    for (const f of rv.findings ?? []) {
      lines.push(`### ${f.id} [${f.severity}]`, '', f.claim, '');
      for (const e of f.evidence ?? []) lines.push(`- \`${e.repo ?? ''}:${e.path}${e.start_line ? `:${e.start_line}` : ''}\`${e.quote ? ` — ${e.quote}` : ''}`);
      lines.push('', `Suggestion: ${f.suggestion}`, '');
    }
    if (rv.acknowledgements?.length) {
      lines.push('## Acknowledgements of earlier responses', '');
      for (const a of rv.acknowledgements) lines.push(`- ${a.finding_id}: ${a.status}${a.note ? ` — ${a.note}` : ''}`);
      lines.push('');
    }
  }
  if (session.verdict === 'in_progress') {
    lines.push('## Next', '', `Planner: answer every finding above in \`sparring/${prefix}responses-${round}.md\` as one \`\`\`json block`,
      '`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,',
      'update `plan.md` (the plan block), commit both and push. That push starts the next round.', '');
  }
  return lines.join('\n');
}

/** Gateway client with long-call tolerance: a lost response is recovered by polling GET /:id. */
export function gatewayClient({ baseUrl, token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, p, body) => {
    try {
      const res = await fetchImpl(`${baseUrl}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(WAIT_MS) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* HTML from a proxy */ }
      return { status: res.status, json };
    } catch (err) {
      return { status: 0, json: null, error: String(err?.message || err) };
    }
  };
  const lost = (r) => r.status === 0 || r.status === 502 || r.status === 503 || r.status === 504;
  const waitFor = async (id, rounds) => {
    const until = now() + WAIT_MS;
    while (now() < until) {
      await sleep(POLL_MS);
      const g = await call('GET', `/api/v1/plans/spar/${id}`);
      const s = g.json?.session;
      if (s && (s.rounds.length >= rounds || s.verdict !== 'in_progress')) return s;
    }
    throw new Error(`session ${id}: no round ${rounds} after ${WAIT_MS / 60000} min`);
  };
  return {
    async create(body) {
      const r = await call('POST', '/api/v1/plans/spar', body);
      if (r.json?.session) return r.json.session.rounds.length >= 1 || r.json.session.verdict !== 'in_progress' ? r.json.session : waitFor(r.json.session.id, 1);
      if (!lost(r)) throw new Error(`create: HTTP ${r.status} ${JSON.stringify(r.json)}`);
      // The pass is still running server-side; re-posting the same plan returns that session (dedup by plan hash).
      const again = await call('POST', '/api/v1/plans/spar', body);
      if (!again.json?.session) throw new Error(`create retry: HTTP ${again.status}`);
      return waitFor(again.json.session.id, 1);
    },
    async round(id, n, body) {
      const r = await call('POST', `/api/v1/plans/spar/${id}/rounds`, body);
      if (r.json?.session) return r.json.session;
      if (r.status === 409 && r.json?.error === 'round_conflict') return waitFor(id, n);
      if (!lost(r)) throw new Error(`round ${n}: HTTP ${r.status} ${JSON.stringify(r.json)}`);
      return waitFor(id, n);
    },
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
      const g = await call('GET', `/api/v1/plans/spar/${id}`);
      return g.json?.session ?? null;
    },
    async allocate(body) {
      const r = await call('POST', '/api/v1/vtid/allocate', body);
      const vtid = r.json?.vtid ?? r.json?.data?.vtid;
      if (!vtid) throw new Error(`allocate: HTTP ${r.status} ${JSON.stringify(r.json)}`);
      return vtid;
    },
  };
}

/** Set front-matter keys (scalars or lists) in a handoff/lane file, keeping the body. A `null` value removes the key. */
export function setFrontMatter(text, patch) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) throw new Error('no front matter');
  let lines = m[1].split(/\r?\n/);
  for (const [k, v] of Object.entries(patch)) {
    const val = Array.isArray(v) ? `[${v.join(', ')}]` : String(v);
    const i = lines.findIndex((l) => new RegExp(`^${k}:`).test(l));
    if (i === -1) { if (v !== null) lines.push(`${k}: ${val}`); continue; }
    // drop a following block list of the old value
    let j = i + 1;
    while (j < lines.length && /^\s+-\s/.test(lines[j])) j++;
    lines = [...lines.slice(0, i), ...(v === null ? [] : [`${k}: ${val}`]), ...lines.slice(j)];
  }
  return `---\n${lines.join('\n')}\n---${text.slice(m[0].length)}`;
}

const appendLog = (text, entry) => `${text.replace(/\s*$/, '')}\n\n${entry}\n`;
const iso = (t) => new Date(t).toISOString().slice(0, 16) + 'Z';

/** Lane files of a spec, sorted (the allocation order). */
const laneFilesOf = (spec) => {
  const lanesDir = path.join(spec, 'lanes');
  return existsSync(lanesDir) ? readdirSync(lanesDir).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(lanesDir, f)) : [];
};
const laneVtid = (lp) => parseFrontMatter(readFileSync(lp, 'utf8'))?.vtid;

/**
 * VTID-05273 — give every lane of a converged, policy-approved plan its VTID; safe to run again on any later
 * PLAN-SPAR run. Idempotent per lane (a lane with `vtid` is skipped). The gate binds one VTID to one sparring record,
 * so the sparring id + plan hash are sent only while the live session is still unbound (`!session.vtid`), with the
 * first lane lacking a VTID; every other allocation is unbound. A session already bound to a VTID that no lane and no
 * handoff `vtids` entry carries (an earlier run allocated it but its files were never committed) is adopted by the
 * first lane lacking a VTID, without calling allocate. The first allocation error stops the loop and keeps what was
 * written; the next run retries the rest. Returns { vtids (this run, incl. adopted), all (every lane VTID), lanes,
 * pending (lane ids still lacking a VTID), failed: null | { lane, error } }.
 */
export async function allocateLanes({ spec, slug, session, client, write, log, t, handoffVtids = [] }) {
  const files = laneFilesOf(spec);
  const laneId = (lp) => path.basename(lp, '.md');
  const vtids = [];
  let failed = null;
  const known = new Set([...handoffVtids, ...files.map(laneVtid).filter(Boolean)]);
  let bind = !session.vtid;
  let adopt = session.vtid && !known.has(session.vtid) ? session.vtid : null;
  for (const lp of files) {
    const lt = readFileSync(lp, 'utf8');
    if (parseFrontMatter(lt)?.vtid) continue;
    let vtid;
    let text;
    if (adopt) {
      vtid = adopt;
      adopt = null;
      text = `${vtid} adopted: already bound to this plan's sparring record by an earlier run whose files were not committed (${POLICY}).`;
    } else {
      try {
        // Only the allocation that binds the record carries sparring_id + plan_hash; all others carry neither.
        vtid = await client.allocate({ source: 'ci-plan-spar', layer: 'DEV', module: slug.toUpperCase().slice(0, 40),
          ...(bind ? { sparring_id: session.id, plan_hash: session.final_plan_hash } : {}) });
      } catch (err) {
        failed = { lane: laneId(lp), error: String(err?.message || err) };
        break;
      }
      bind = false;
      text = `${vtid} allocated after policy approval (${POLICY}).`;
    }
    vtids.push(vtid);
    write(lp, appendLog(setFrontMatter(lt, { vtid, next_actor: 'kiro', updated: t }), log('ready (VTID allocated)', text)));
  }
  const all = files.map(laneVtid).filter(Boolean);
  const pending = files.filter((lp) => !laneVtid(lp)).map(laneId);
  return { vtids, all, lanes: files.length, pending, failed };
}

/**
 * One step for one plan. Returns { action, wrote: [paths] }. `client` is gatewayClient(); `env` carries
 * PLAN_SPAR_ALLOCATE. Reads and writes only below `<dir>/.kiro/specs/<slug>/`.
 */
export async function step({ dir, slug, baseSha, repo, client, allocate = false, extraRefs = null, now = Date.now }) {
  const spec = path.join(dir, '.kiro/specs', slug);
  const rel = (p) => path.relative(dir, p);
  const planPath = path.join(spec, 'plan.md');
  if (!existsSync(planPath)) throw new Usage(`${rel(planPath)} not found`);
  const planText = readFileSync(planPath, 'utf8');
  if (!planText.includes('<!-- plan:begin -->') || !planText.includes('<!-- plan:end -->')) throw new Usage('plan.md needs <!-- plan:begin --> … <!-- plan:end -->');
  const changeClass = parseFrontMatter(planText)?.change_class || 'standard';
  const sdir = path.join(spec, 'sparring');
  mkdirSync(sdir, { recursive: true });
  const statePath = path.join(sdir, 'state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { sessions: [] };
  const wrote = [];
  const write = (p, t) => { writeFileSync(p, t); wrote.push(rel(p)); };
  const cur = state.sessions[state.sessions.length - 1];

  // Files of session k > 1 carry an `s<k>-` prefix (round and responses numbers restart in a new session).
  const prefix = (k) => (k > 1 ? `s${k}-` : '');
  let session;
  let action;
  const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable;
  const replan = cur && cur.verdict === 'escalated' && !cur.infra && state.sessions.length < MAX_SESSIONS && cur.plan_text_sha !== sha(planText);
  if (!cur || retryInfra || replan) {
    action = !cur ? 'create' : retryInfra ? 'retry' : 'replan';
    // A partner outage does not use up one of the plan's sessions: the retry replaces it.
    if (retryInfra) state.sessions.pop();
    session = await client.create({
      plan_text: planText, producer: `ci-plan-spar.${slug}`, change_class: changeClass, base_ref: baseSha, repo, approval_policy: POLICY,
      // VTID-05215/R1-F1: native plans premise on code in exafyltd/vitana-v1, which the base-repo
      // (vitana-platform) session cannot read. Pin a vitana-v1 ref so the partner's read_file/search_code
      // tools can verify those file:line claims. Only sent when a ref was resolved (platform-only plans
      // leave extraRefs null, so their sessions are byte-for-byte unchanged). The gateway validates each
      // key against PLAN_SPARRING_REPOS and refuses an unpinned repo.
      ...(extraRefs && Object.keys(extraRefs).length ? { extra_refs: extraRefs } : {}),
    });
    state.sessions.push({ id: session.id, submitted: [], plan_text_sha: sha(planText) });
  } else if (cur.verdict === 'in_progress') {
    const n = cur.rounds;
    // state.json lives on the PR branch, so it is untrusted: the session must be this plan's own (producer
    // ci-plan-spar.<slug>) and still at the round the state claims, or nothing is submitted.
    const live = await client.get(cur.id);
    if (!live || live.producer !== `ci-plan-spar.${slug}` || live.verdict !== 'in_progress' || live.rounds.length !== n) {
      throw new Error(`sparring/state.json names session ${cur.id}, which is not this plan's in-progress session at round ${n}`);
    }
    const respPath = path.join(sdir, `${prefix(state.sessions.length)}responses-${n}.md`);
    if (!existsSync(respPath) || cur.submitted.includes(n)) return { action: 'waiting_for_planner', wrote };
    action = 'round';
    session = await client.round(cur.id, n + 1, { responses: parseResponses(readFileSync(respPath, 'utf8')), revised_plan_text: planText });
    cur.submitted.push(n);
    cur.plan_text_sha = sha(planText);
  } else if (cur.verdict === 'converged' && cur.policy_approved_at && allocate && laneFilesOf(spec).some((lp) => !laneVtid(lp))) {
    // VTID-05273: a lane without a VTID on a plan that converged in an earlier run (a late lane, a lane-less plan that
    // got its lanes, or an allocation that failed). No new round: verify the live session, then allocate below.
    // state.json is PR-controlled, so the session must be this plan's own, converged, policy-approved session with
    // the same final plan hash, or nothing is allocated.
    const live = await client.get(cur.id);
    if (!live || live.producer !== `ci-plan-spar.${slug}` || live.verdict !== 'converged' || !live.policy_approved_at || live.final_plan_hash !== cur.final_plan_hash) {
      throw new Error(`sparring/state.json names session ${cur.id}, which is not this plan's converged, policy-approved session`);
    }
    action = 'allocate_retry';
    session = live;
  } else {
    return { action: 'nothing_to_do', wrote };
  }

  const entry = state.sessions[state.sessions.length - 1];
  if (action !== 'allocate_retry') {
    const seen = entry.rounds ?? 0;
    for (const r of session.rounds.filter((x) => x.round > seen)) write(path.join(sdir, `${prefix(state.sessions.length)}round-${r.round}.md`), renderRound(session, r.round, prefix(state.sessions.length)));
    entry.rounds = session.rounds.length;
    entry.verdict = session.verdict;
    entry.infra = (session.escalation_reasons ?? []).some((x) => INFRA_REASONS.includes(x));
    entry.retryable = (session.escalation_reasons ?? []).some((x) => RETRYABLE_REASONS.includes(x));
    entry.final_plan_hash = session.final_plan_hash ?? null;
    entry.policy_approved_at = session.policy_approved_at ?? null;
    write(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  const handoffPath = path.join(spec, 'handoff.md');
  const t = iso(now());
  const log = (change, text) => `### ${t} · ci-plan-spar · ${change}\n${text}`;
  let failed = null;
  if (session.verdict === 'converged' && session.policy_approved_at) {
    if (action !== 'allocate_retry') action = `${action}+approved`;
    const ht = existsSync(handoffPath) ? readFileSync(handoffPath, 'utf8') : null;
    const fm = (ht && parseFrontMatter(ht)) || {};
    const handoffVtids = Array.isArray(fm.vtids) ? fm.vtids : [];
    const res = allocate
      ? await allocateLanes({ spec, slug, session, client, write, log, t, handoffVtids })
      : { vtids: [], all: laneFilesOf(spec).map(laneVtid).filter(Boolean), lanes: laneFilesOf(spec).length, pending: [], failed: null };
    failed = res.failed;
    if (failed) action = `${action}+partial`;
    write(path.join(sdir, 'verdict.md'), `# Verdict — ${slug}\n\nCONVERGED and approved by policy \`${POLICY}\` at ${session.policy_approved_at}.\nSession \`${session.id}\` · final plan hash \`${session.final_plan_hash}\`.\n${res.all.length ? `VTIDs: ${res.all.join(', ')}\n` : allocate ? '' : 'VTID allocation is off (PLAN_SPAR_ALLOCATE) — Claude Code allocates.\n'}`);
    if (ht !== null) {
      const allVtids = [...new Set([...handoffVtids, ...res.vtids])];
      const approved = allocate && allVtids.length > 0;
      const from = fm.state || 'drafted';
      const to = approved ? 'approved' : 'sparred';
      // Allocation on: the plan is always Kiro's next move. `reason` says why it is not fully allocated yet.
      const reason = !allocate ? undefined : res.lanes === 0 ? 'lanes_missing' : (failed || res.pending.length) ? 'allocation_pending' : null;
      let text;
      if (!allocate) text = `Converged; approved by policy ${POLICY}. VTID allocation is off — next_actor claude allocates.`;
      else if (reason === 'lanes_missing') text = `Converged; approved by policy ${POLICY}. No lane files yet; add them in a \`_plan\` commit on this PR and the next PLAN-SPAR run allocates their VTIDs.`;
      else {
        text = `Converged; approved by policy ${POLICY}. ${res.vtids.length} lane(s) got a VTID and are handed to Kiro.`;
        if (failed) text += ` VTID allocation failed for lane ${failed.lane} (${failed.error}); ${res.pending.length} lane(s) still lack a VTID — the next PLAN-SPAR run on this PR retries them.`;
      }
      write(handoffPath, appendLog(setFrontMatter(ht, {
        state: to, next_actor: allocate ? 'kiro' : 'claude', sparring_record: `.kiro/specs/${slug}/sparring/verdict.md`,
        ...(approved ? { vtids: allVtids } : {}), ...(reason !== undefined ? { reason } : {}), updated: t,
      }), log(from === to && action.startsWith('allocate_retry') ? `${to} (late lane VTID)` : `${from} → ${to}`, text)));
    }
  } else if (session.verdict === 'escalated') {
    const infra = entry.infra;
    const last = state.sessions.length >= MAX_SESSIONS;
    action = `${action}+escalated${infra ? '-infra' : last ? '-parked' : ''}`;
    if (existsSync(handoffPath) && (infra || last)) {
      const ht = readFileSync(handoffPath, 'utf8');
      const fm = parseFrontMatter(ht) || {};
      write(handoffPath, appendLog(setFrontMatter(ht, infra
        ? { next_actor: 'claude', updated: t }
        : { state: 'parked', parked_from: fm.state === 'parked' ? fm.parked_from : (fm.state || 'drafted'), next_actor: 'claude', updated: t }),
      log(infra ? 'escalated (partner unavailable)' : `${fm.state || 'drafted'} → parked`, infra
        ? `The sparring partner could not review (${(session.escalation_reasons ?? []).join(', ')}). Not a plan problem: Claude Code looks at the partner, then re-runs.`
        : `Not converged after ${MAX_SESSIONS} sparring sessions (${(session.escalation_reasons ?? []).join(', ')}). Parked with the open findings in sparring/.`)));
    }
  }
  return { action, wrote, session_id: session.id, verdict: session.verdict, ...(failed ? { failed } : {}) };
}

function sha(t) {
  // Small, dependency-free fingerprint: only used to notice that plan.md changed between sessions.
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)$/.exec(argv[i]);
    if (m) out[m[1]] = argv[++i];
  }
  return out;
}

async function main(argv) {
  const a = parseArgs(argv);
  if (!a.dir || !a['base-sha'] || !a.repo || !a.changed) throw new Usage('needs --dir --base-sha --repo --changed');
  if (!/^[0-9a-f]{40}$/.test(a['base-sha'])) throw new Usage('--base-sha must be a commit sha');
  const slug = detectSlug(readFileSync(a.changed, 'utf8').split('\n'));
  const say = (s) => (a.summary ? writeFileSync(a.summary, `${s}\n`, { flag: 'a' }) : console.log(s));
  if (!slug) { say('➖ **plan-spar** — no plan.md or responses file changed'); return 0; }
  const { GATEWAY_URL, GATEWAY_SERVICE_TOKEN } = process.env;
  if (!GATEWAY_URL || !GATEWAY_SERVICE_TOKEN) { say('❌ **plan-spar** — GATEWAY_URL / GATEWAY_SERVICE_TOKEN not configured'); return 1; }
  const client = gatewayClient({ baseUrl: GATEWAY_URL.replace(/\/$/, ''), token: GATEWAY_SERVICE_TOKEN });
  // VTID-05215/R1-F1: a resolved vitana-v1 commit SHA (from PLAN-SPAR.yml) lets the partner read
  // exafyltd/vitana-v1 for native plans. Optional and validated: only a 40-hex SHA is forwarded, and only
  // under the exafyltd/vitana-v1 key, so a missing/garbage value simply leaves platform-only behaviour.
  const v1Sha = (a['extra-ref-vitana-v1'] || '').trim();
  const extraRefs = /^[0-9a-f]{40}$/.test(v1Sha) ? { 'exafyltd/vitana-v1': v1Sha } : null;
  const r = await step({ dir: a.dir, slug, baseSha: a['base-sha'], repo: a.repo, client, allocate: process.env.PLAN_SPAR_ALLOCATE === 'true', extraRefs });
  say(`✅ **plan-spar** — ${slug}: ${r.action}${r.verdict ? ` (verdict ${r.verdict})` : ''}; wrote ${r.wrote.length} file(s)`);
  // VTID-05273: a failed allocation exits 0 so the workflow commits the VTIDs already written; the next run retries.
  if (r.failed) say(`⚠️ **plan-spar** — VTID allocation pending for lane ${r.failed.lane}: ${r.failed.error}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => {
    console.error(`plan-spar: ${e.message}`);
    process.exitCode = e instanceof Usage ? 2 : 1;
  });
}
