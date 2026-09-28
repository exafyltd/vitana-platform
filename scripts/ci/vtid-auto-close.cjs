#!/usr/bin/env node
// VTID-04691 — close a VTID in the ledger when its PR merges.
//
// Why: the ledger kept filling with work that had shipped long ago but was
// never terminalized (341 rows closed by hand on 2026-09-26). Sessions and
// people forget the governed completion call; a merge is the one event every
// change goes through, so the close happens there.
//
// What it closes: the VTIDs named in the merged PR's TITLE — never the body,
// which routinely cites older, unrelated VTIDs as background (the same
// mistake VTID-03696 fixed in VALIDATOR-CHECK's VTID extraction).
//
// What it deliberately leaves alone:
//   - rows that are already terminal. The completion endpoint only treats
//     `completed` as idempotent: calling it on a `cancelled` or `rejected`
//     row would overwrite that decision with success.
//   - Dev Autopilot PRs (head branch `dev-autopilot/…`). That pipeline
//     terminalizes its own VTIDs after deploy + verification, and can still
//     mark them failed after the merge; closing at merge would pre-empt it.
//   - PRs that opt out, for work that needs more than one PR: a
//     `vtid-keep-open` label or a `VTID_AUTO_CLOSE: no` line in the body.
//
// Failures are reported and never fail the job: a missed close is the state
// the ledger was already in, and a red check on a merged PR helps nobody.

'use strict';

const VTID_RE = /\bVTID-(\d{4,5})\b/g;
const KEEP_OPEN_LABEL = 'vtid-keep-open';
const OPT_OUT_LINE = /^\s*VTID_AUTO_CLOSE:\s*(no|false|off)\s*$/im;
const DEV_AUTOPILOT_BRANCH = /^dev-autopilot\//;
const CLOSE_REASON = 'PR merged to main';

/** Distinct VTIDs in a PR title, in order of first appearance. */
function extractTitleVtids(title) {
  const seen = new Set();
  const out = [];
  for (const m of String(title || '').matchAll(VTID_RE)) {
    const v = `VTID-${m[1]}`;
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Whether this merged PR's VTIDs should be closed at all, and why not. */
function autoCloseDecision({ headRef, labels, body }) {
  if (DEV_AUTOPILOT_BRANCH.test(String(headRef || ''))) {
    return { close: false, reason: 'Dev Autopilot PR: its pipeline terminalizes the VTID after verification' };
  }
  const names = (labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
  if (names.includes(KEEP_OPEN_LABEL)) {
    return { close: false, reason: `label ${KEEP_OPEN_LABEL}` };
  }
  if (OPT_OUT_LINE.test(String(body || ''))) {
    return { close: false, reason: 'VTID_AUTO_CLOSE: no in the PR body' };
  }
  return { close: true, reason: null };
}

/** What to do with one ledger row, given the read endpoint's answer. */
function rowAction(row) {
  if (!row) return { act: false, why: 'not in the ledger' };
  if (row.is_terminal === true) {
    return { act: false, why: `already terminal (${row.status}/${row.terminal_outcome || 'n/a'})` };
  }
  return { act: true, why: `was ${row.status}` };
}

async function readRow(gateway, vtid, fetchImpl) {
  const res = await fetchImpl(`${gateway}/api/v1/oasis/tasks/${vtid}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`read ${vtid}: HTTP ${res.status}`);
  return res.json();
}

async function closeRow(gateway, vtid, prRef, fetchImpl) {
  const res = await fetchImpl(`${gateway}/api/v1/oasis/tasks/${vtid}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminal_outcome: 'success', reason: `${CLOSE_REASON} (${prRef})` }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok !== true) {
    throw new Error(`close ${vtid}: HTTP ${res.status} ${json.error || ''}`.trim());
  }
  return json;
}

/**
 * Close the VTIDs of one merged PR. Returns one result line per VTID; never
 * throws for a per-VTID failure.
 */
async function autoClose({ gateway, pr, fetchImpl = fetch, log = console.log }) {
  const vtids = extractTitleVtids(pr.title);
  const results = [];
  if (vtids.length === 0) {
    log('No VTID in the PR title — nothing to close.');
    return results;
  }
  const decision = autoCloseDecision({ headRef: pr.headRef, labels: pr.labels, body: pr.body });
  if (!decision.close) {
    log(`Skipped ${vtids.join(', ')}: ${decision.reason}.`);
    return vtids.map((vtid) => ({ vtid, outcome: 'skipped', detail: decision.reason }));
  }
  for (const vtid of vtids) {
    try {
      const row = await readRow(gateway, vtid, fetchImpl);
      const action = rowAction(row);
      if (!action.act) {
        results.push({ vtid, outcome: 'left', detail: action.why });
        continue;
      }
      await closeRow(gateway, vtid, pr.ref, fetchImpl);
      results.push({ vtid, outcome: 'closed', detail: action.why });
    } catch (err) {
      results.push({ vtid, outcome: 'error', detail: err.message });
    }
  }
  for (const r of results) log(`${r.vtid}: ${r.outcome} — ${r.detail}`);
  return results;
}

async function main() {
  const gateway = (process.env.GATEWAY_URL || 'https://gateway.vitanaland.com').replace(/\/+$/, '');
  const pr = {
    title: process.env.PR_TITLE || '',
    body: process.env.PR_BODY || '',
    headRef: process.env.PR_HEAD_REF || '',
    labels: JSON.parse(process.env.PR_LABELS || '[]'),
    ref: process.env.PR_REF || 'unknown PR',
  };
  const results = await autoClose({ gateway, pr });
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary && results.length) {
    const lines = ['| VTID | Result | Detail |', '|---|---|---|'];
    for (const r of results) lines.push(`| ${r.vtid} | ${r.outcome} | ${r.detail.replace(/\|/g, '/')} |`);
    require('fs').appendFileSync(summary, `### VTID auto-close\n\n${lines.join('\n')}\n`);
  }
  const errors = results.filter((r) => r.outcome === 'error');
  if (errors.length) {
    console.log(`::warning::${errors.length} VTID(s) could not be closed — close them by hand with POST /api/v1/oasis/tasks/<vtid>/complete.`);
  }
}

module.exports = { extractTitleVtids, autoCloseDecision, rowAction, autoClose };

if (require.main === module) {
  main().catch((err) => {
    console.log(`::warning::VTID auto-close did not run: ${err.message}`);
  });
}
