#!/usr/bin/env node
/**
 * VTID-05354 (plan pipeline-agent-wake-and-review, lane driver-wake): wake an absent plan driver when a sparring or
 * review result arrives, instead of waiting for the hourly seat automation.
 *
 *   node scripts/collab/driver-wake.mjs run --repo <dir> --event <$GITHUB_EVENT_PATH> --event-name <$GITHUB_EVENT_NAME>
 *
 * Events: a PLAN-SPAR workflow_run that completed (success or failure) on a same-repo `plan(<slug>)` PR; a push to
 * `kiro/<slug>/<lane>` whose commits carry `Collab-Verdict:`; a manual dispatch with a slug. Decision order:
 * invalid slug → skip; KIRO_API_KEY not configured → skip (green, summary line); driver heartbeat < 45 min → skip;
 * a wake marker for the slug < 20 min → skip; ≥ 6 markers in the last hour repo-wide → skip; else wake.
 * Every run first deletes `collab-wake/*` markers older than 2 h. On `wake` it writes the marker (tree = main's,
 * fast-forward only) and prints `decision=wake` / `slug=<slug>` to $GITHUB_OUTPUT; the workflow then starts one Kiro
 * cloud session with the fixed prompt of `wakePrompt` (no event text reaches the prompt).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ALIVE_MS, heartbeatAge } from './plan-driver.mjs';

// Same pattern as queue.mjs:57 and plan-driver.mjs:39 (module-private there; driver-wake.test.mjs pins equality).
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MARKER_PREFIX = 'collab-wake/';
export const RECENT_MS = 20 * 60_000;
export const BUDGET_WINDOW_MS = 60 * 60_000;
export const BUDGET = 6;
export const PRUNE_MS = 2 * 60 * 60_000;

const SKIP = (reason) => ({ skip: reason });

/** { slug, why } for an actionable event, else { skip }. Pure. */
export function parseEvent(name, ev) {
  if (name === 'workflow_dispatch') {
    const s = String(ev?.inputs?.slug || '');
    return SLUG_RE.test(s) ? { slug: s, why: 'manual dispatch' } : SKIP('not a plan event');
  }
  if (name === 'workflow_run') {
    const r = ev?.workflow_run || {};
    if (r.name !== 'PLAN-SPAR') return SKIP('not a plan event');
    if ((r.head_repository?.full_name || '') !== (ev?.repository?.full_name || '')) return SKIP('fork');
    const m = /^plan\(([^)]*)\)/.exec(String(r.display_title || ''));
    if (!m || !SLUG_RE.test(m[1])) return SKIP('not a plan event');
    return { slug: m[1], why: `PLAN-SPAR ${r.conclusion || 'completed'}` };
  }
  if (name === 'push') {
    // kiro/<slug>/<lane>, and the closing-record form kiro/close/<slug>/<lane>-iN.
    const m = /^refs\/heads\/kiro\/(?:close\/)?([^/]+)\/[^/]+/.exec(String(ev?.ref || ''));
    if (!m || !SLUG_RE.test(m[1])) return SKIP('not a plan event');
    const verdict = (ev.commits || []).some((c) => /^Collab-Verdict:\s*\S/m.test(String(c?.message || '')));
    return verdict ? { slug: m[1], why: 'review verdict pushed' } : SKIP('not a plan event');
  }
  return SKIP('not a plan event');
}

/** { decision: 'wake'|'skip', reason }. Pure. `markers` = [{ slug, at }]. */
export function decide({ slug, now, heartbeatAgeMs, markers = [], keySet }) {
  if (!SLUG_RE.test(slug || '')) return { decision: 'skip', reason: 'not a plan event' };
  if (!keySet) return { decision: 'skip', reason: 'wake unavailable: KIRO_API_KEY not configured' };
  if (typeof heartbeatAgeMs === 'number' && heartbeatAgeMs < ALIVE_MS) return { decision: 'skip', reason: 'driver alive' };
  if (markers.some((m) => m.slug === slug && now - m.at < RECENT_MS)) return { decision: 'skip', reason: 'woken recently' };
  if (markers.filter((m) => now - m.at < BUDGET_WINDOW_MS).length >= BUDGET) return { decision: 'skip', reason: 'wake budget' };
  return { decision: 'wake', reason: 'no live driver' };
}

/** The only text a woken session receives. */
export function wakePrompt(slug) {
  if (!SLUG_RE.test(slug || '')) throw new Error('invalid slug');
  return `Read docs/kiro/driver-wake.md in vitana-platform, section "For the woken session", and follow it for plan ${slug}.`;
}

const git = (repo, args, opts = {}) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const gitOk = (repo, args) => { try { return git(repo, args); } catch { return null; } };

/** Markers on origin: [{ slug, sha, at }]. */
export function listMarkers(repo) {
  const out = gitOk(repo, ['ls-remote', 'origin', `refs/heads/${MARKER_PREFIX}*`]) || '';
  const refs = out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)).map(([sha, ref]) => ({ sha, slug: ref.slice(`refs/heads/${MARKER_PREFIX}`.length) }));
  if (refs.length) git(repo, ['fetch', '-q', 'origin', ...refs.map((r) => `refs/heads/${MARKER_PREFIX}${r.slug}`)]);
  return refs.map((r) => ({ ...r, at: Number(git(repo, ['log', '-1', '--format=%ct', r.sha])) * 1000 }));
}

/** Delete markers older than 2 h; returns the deleted slugs. */
export function pruneMarkers(repo, markers, { now = Date.now() } = {}) {
  const old = markers.filter((m) => now - m.at >= PRUNE_MS);
  for (const m of old) gitOk(repo, ['push', '-q', 'origin', '--delete', `refs/heads/${MARKER_PREFIX}${m.slug}`]);
  return old.map((m) => m.slug);
}

/** Write (fast-forward) the marker for `slug`: a commit with main's tree, parent = previous marker or main. */
export function writeMarker(repo, slug, { now = Date.now() } = {}) {
  if (!SLUG_RE.test(slug)) throw new Error('invalid slug');
  git(repo, ['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const ref = `refs/heads/${MARKER_PREFIX}${slug}`;
  const prev = (gitOk(repo, ['ls-remote', 'origin', ref]) || '').split(/\s+/)[0];
  if (prev) git(repo, ['fetch', '-q', 'origin', ref]);
  const tree = git(repo, ['rev-parse', 'origin/main^{tree}']);
  const parent = prev || git(repo, ['rev-parse', 'origin/main']);
  const when = `${Math.floor(now / 1000)} +0000`;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'driver-wake', GIT_AUTHOR_EMAIL: 'driver-wake@collab.invalid', GIT_COMMITTER_NAME: 'driver-wake', GIT_COMMITTER_EMAIL: 'driver-wake@collab.invalid', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  const sha = git(repo, ['commit-tree', tree, '-p', parent, '-m', `collab-wake ${slug}`, '-m', `Collab-Wake: ${slug}`], { env });
  git(repo, ['push', '-q', 'origin', `${sha}:${ref}`]);
  return sha;
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv, env = process.env) {
  if (argv[0] !== 'run') { console.error('usage: driver-wake.mjs run --repo <dir> --event <file> --event-name <name>'); return 2; }
  const repo = arg(argv, 'repo') || '.';
  const evName = arg(argv, 'event-name') || '';
  const ev = JSON.parse(readFileSync(arg(argv, 'event'), 'utf8'));
  const now = Date.now();
  const say = (k, v) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`);
  const summary = (line) => { console.log(line); if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`); };
  const p = parseEvent(evName, ev);
  if (p.skip) { say('decision', 'skip'); summary(`driver-wake: skip (${p.skip})`); return 0; }
  let markers = listMarkers(repo);
  const pruned = pruneMarkers(repo, markers, { now });
  markers = markers.filter((m) => !pruned.includes(m.slug));
  const keySet = env.KIRO_API_KEY_SET === 'true';
  const heartbeatAgeMs = keySet ? heartbeatAge(repo, p.slug, { now }) : 'none';
  const d = decide({ slug: p.slug, now, heartbeatAgeMs, markers, keySet });
  say('decision', d.decision);
  if (d.decision !== 'wake') { summary(`driver-wake: ${p.slug}: skip (${d.reason}) — event: ${p.why}`); return 0; }
  if (env.DRY_RUN === 'true') { summary(`driver-wake: ${p.slug}: would wake (dry run, no marker) — event: ${p.why}`); say('decision', 'dry-run'); return 0; }
  const sha = writeMarker(repo, p.slug, { now });
  say('slug', p.slug);
  summary(`driver-wake: ${p.slug}: wake (marker ${sha.slice(0, 8)}) — event: ${p.why}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main(process.argv.slice(2)));
