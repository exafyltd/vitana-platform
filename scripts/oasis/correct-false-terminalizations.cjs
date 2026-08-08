#!/usr/bin/env node
/**
 * VTID-03516 — repair the false `rejected`/`failed` verdicts in vtid_ledger.
 *
 * BACKGROUND
 * ----------
 * The worker-runner claimed VTIDs that Claude Code sessions had allocated for
 * their own in-session work, failed instantly on a missing ANTHROPIC_API_KEY,
 * and terminalized them status='rejected' / terminal_outcome='failed'. 25 rows
 * carry that false verdict. See ci_ledger_integrity_check() and
 * isAutonomousExecutionTask() in routes/worker-orchestrator.ts.
 *
 * ORDERING — READ THIS FIRST
 * --------------------------
 * Run this only AFTER the ownership gate is live on the gateway that the
 * worker-runner polls (currently AWS prod, `vitana-gateway-awsdr`). Rows this
 * script sets back to a non-terminal state before then would simply be
 * re-claimed and re-swept, and the re-sweep would overwrite `updated_at` —
 * the timestamps that identify the writer. Rows left terminal are not
 * re-claimable, so the success path below is safe either way; the script still
 * refuses to run without --i-have-deployed-the-gate so the ordering is a
 * deliberate decision rather than an accident.
 *
 * WHY IT DOES NOT JUST FLIP ALL 25 TO success
 * -------------------------------------------
 * Because that would replace one false claim with another. "The autonomous
 * plane had no business judging this" is not the same statement as "this
 * work succeeded", and OASIS is the source of truth — it should not be made
 * to assert something nobody verified. So:
 *
 *   - A VTID with merged commits on origin/main → evidence it shipped →
 *     status='completed', terminal_outcome='success'.
 *   - A VTID without → the verdict is VOIDED, not inverted. The row keeps a
 *     terminal state (so it stays un-claimable) but gains
 *     metadata.ledger_verdict_disputed describing why its 'failed' cannot be
 *     trusted, and is printed for human adjudication. Absence of a merged
 *     commit is not proof of failure — some of this work landed in
 *     exafyltd/vitana-v1, some was investigation with no commit at all.
 *
 * USAGE
 *   node scripts/oasis/correct-false-terminalizations.cjs                 # dry run
 *   node scripts/oasis/correct-false-terminalizations.cjs --apply --i-have-deployed-the-gate
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE
 */

const { execSync } = require('node:child_process');

const APPLY = process.argv.includes('--apply');
const GATE_CONFIRMED = process.argv.includes('--i-have-deployed-the-gate');
const LOOKBACK_DAYS = Number(
  (process.argv.find((a) => a.startsWith('--lookback-days=')) || '').split('=')[1] || 30,
);

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!SUPABASE_URL || !SERVICE_ROLE) die('SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set.');
if (APPLY && !GATE_CONFIRMED) {
  die(
    'Refusing to --apply without --i-have-deployed-the-gate.\n' +
      'The ownership gate (isAutonomousExecutionTask) must be live on the gateway the\n' +
      'worker-runner polls first, or corrected rows get re-swept and the forensic\n' +
      'timestamps are lost. See the header of this file.',
  );
}

const headers = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  'Content-Type': 'application/json',
};

/** Merged commits on origin/main mentioning the VTID — our shipped-evidence. */
function mergedCommitCount(vtid) {
  try {
    const out = execSync(`git log origin/main --oneline --grep="${vtid}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function main() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ci_ledger_integrity_check`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_lookback_days: LOOKBACK_DAYS }),
  });
  if (!res.ok) {
    die(
      `ci_ledger_integrity_check returned HTTP ${res.status}. If 404, apply ` +
        'supabase/migrations/20260806160000_vtid_03516_ledger_integrity_check.sql.',
    );
  }
  const findings = await res.json();

  if (!findings.length) {
    console.log('No false terminalizations found. Nothing to correct.');
    return;
  }

  const shipped = [];
  const disputed = [];
  for (const f of findings) {
    (mergedCommitCount(f.vtid) > 0 ? shipped : disputed).push(f);
  }

  console.log(`${findings.length} false verdict(s) over ${LOOKBACK_DAYS}d`);
  console.log(`  ${shipped.length} with merged commits on origin/main -> completed/success`);
  console.log(`  ${disputed.length} without -> verdict voided, flagged for human adjudication`);
  console.log(APPLY ? '\nAPPLYING\n' : '\nDRY RUN (pass --apply to write)\n');

  const stamp = new Date().toISOString();

  for (const f of shipped) {
    console.log(`  [success]  ${f.vtid}  ${f.title}`);
    if (!APPLY) continue;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(f.vtid)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'completed',
        is_terminal: true,
        terminal_outcome: 'success',
        updated_at: stamp,
      }),
    });
    if (!r.ok) console.error(`    FAILED HTTP ${r.status}`);
  }

  for (const f of disputed) {
    console.log(`  [disputed] ${f.vtid}  ${f.title}`);
    if (!APPLY) continue;
    // Read-modify-write: PostgREST has no jsonb merge, and clobbering metadata
    // would destroy allocated_at / requested_by / pr_url provenance.
    const cur = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(f.vtid)}&select=metadata`,
      { headers },
    ).then((x) => x.json());
    const metadata = { ...(cur?.[0]?.metadata || {}) };
    metadata.ledger_verdict_disputed = {
      governance_vtid: 'VTID-03516',
      reason:
        "terminal_outcome='failed' was written by the autonomous execution plane, " +
        'which had claimed this VTID in error. The failure is not evidence about ' +
        'this work. No merged commit found on origin/main, so success was not ' +
        'asserted either — needs human adjudication.',
      disputed_at: stamp,
    };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(f.vtid)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata, updated_at: stamp }),
    });
    if (!r.ok) console.error(`    FAILED HTTP ${r.status}`);
  }

  if (!APPLY) console.log('\nNothing written.');
}

main().catch((e) => die(e.message));
