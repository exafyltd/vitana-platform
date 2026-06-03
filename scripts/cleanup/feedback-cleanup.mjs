#!/usr/bin/env node
/**
 * Feedback Cleanup — DRY-RUN-by-default status-transition tool.
 * Marker: BOOTSTRAP-FEEDBACK-CLEANUP
 *
 * Operates ONLY on public.feedback_tickets. Performs ONLY status transitions
 * (duplicate / rejected) plus the linked duplicate_of / supervisor_notes field.
 * NEVER deletes. NEVER touches a terminal ticket. NEVER touches a cluster
 * canonical. DRY-RUN unless --execute is passed.
 *
 * Usage:
 *   node scripts/cleanup/feedback-cleanup.mjs --inventory
 *   node scripts/cleanup/feedback-cleanup.mjs --class A            # dry-run
 *   node scripts/cleanup/feedback-cleanup.mjs --class A --execute
 *   node scripts/cleanup/feedback-cleanup.mjs --class C1 --stale-days 45 [--execute]
 *   node scripts/cleanup/feedback-cleanup.mjs --class C2 --stale-days 60 [--execute]
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE
 *
 * See docs/cleanup/feedback-cleanup-report.md and feedback-cleanup-runbook.md.
 */

import { createClient } from '@supabase/supabase-js';

const TERMINAL = ['resolved', 'user_confirmed', 'rejected', 'wont_fix', 'duplicate'];
const REPORT_ONLY = new Set(['B', 'C3', 'D']);

function parseArgs(argv) {
  const a = { class: null, execute: false, inventory: false, staleDays: 45 };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--execute') a.execute = true;
    else if (t === '--inventory') a.inventory = true;
    else if (t === '--class') a.class = argv[++i];
    else if (t === '--stale-days') a.staleDays = parseInt(argv[++i], 10);
    else { console.error(`Unknown arg: ${t}`); process.exit(2); }
  }
  return a;
}

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set.');
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const norm = (s) => (s || '').trim().toLowerCase();

function lastActivity(t) {
  const ts = [t.created_at, t.triaged_at, t.resolved_at, t.user_confirmed_at]
    .filter(Boolean)
    .map((x) => new Date(x).getTime());
  return Math.max(...ts, 0);
}

async function fetchOpenTickets(supa) {
  // Pull the fields we need; only open tickets matter for cleanup.
  const { data, error } = await supa
    .from('feedback_tickets')
    .select('id, ticket_number, user_id, kind, status, priority, raw_transcript, created_at, triaged_at, resolved_at, user_confirmed_at, duplicate_of, supervisor_notes')
    .not('status', 'in', `(${TERMINAL.join(',')})`)
    .order('created_at', { ascending: true });
  if (error) { console.error('Query failed:', error.message); process.exit(1); }
  return data || [];
}

async function inventory(supa) {
  const { data, error } = await supa.from('feedback_tickets').select('status');
  if (error) { console.error('Query failed:', error.message); process.exit(1); }
  const counts = {};
  for (const r of data) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log('\n=== feedback_tickets — counts by status ===');
  for (const [s, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(16)} ${n}`);
  }
  console.log(`  ${'TOTAL'.padEnd(16)} ${data.length}\n`);

  const open = await fetchOpenTickets(supa);
  const clusters = classA(open);
  console.log(`Class A exact-dup clusters (open): ${clusters.length}`);
  for (const c of clusters) {
    console.log(`  canonical ${c.canonical.ticket_number} + ${c.dups.length} dup(s): ${c.dups.map((d) => d.ticket_number).join(', ')}`);
  }
  console.log('');
}

// Class A: group open tickets by normalized transcript; clusters of >1.
function classA(open) {
  const byKey = new Map();
  for (const t of open) {
    const k = norm(t.raw_transcript);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const clusters = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const [canonical, ...dups] = group; // oldest is canonical
    clusters.push({ canonical, dups });
  }
  return clusters;
}

// Class C1/C2: stale open tickets matching sub-class predicate.
function classC(open, sub, staleDays) {
  const cutoff = Date.now() - staleDays * 86400_000;
  return open.filter((t) => {
    if (lastActivity(t) >= cutoff) return false;
    if (sub === 'C1') return t.status === 'needs_more_info';
    if (sub === 'C2') return t.priority === 'p3' && ['feature_request', 'feedback'].includes(t.kind);
    return false;
  });
}

async function applyDuplicate(supa, dup, canonicalId, execute) {
  const label = `${dup.ticket_number} → duplicate (of ${canonicalId})`;
  if (!execute) { console.log(`[DRY-RUN] would mark-duplicate ${label}`); return; }
  const { error } = await supa
    .from('feedback_tickets')
    .update({ status: 'duplicate', duplicate_of: canonicalId })
    .eq('id', dup.id)
    .not('status', 'in', `(${TERMINAL.join(',')})`); // guard: skip if already terminal
  if (error) console.error(`  FAIL ${label}: ${error.message}`);
  else console.log(`[OASIS] feedback.ticket.status_changed ${label}`);
}

async function applyReject(supa, t, reason, execute) {
  const label = `${t.ticket_number} → rejected (${reason})`;
  if (!execute) { console.log(`[DRY-RUN] would reject ${label}`); return; }
  const { error } = await supa
    .from('feedback_tickets')
    .update({ status: 'rejected', supervisor_notes: reason })
    .eq('id', t.id)
    .not('status', 'in', `(${TERMINAL.join(',')})`);
  if (error) console.error(`  FAIL ${label}: ${error.message}`);
  else console.log(`[OASIS] feedback.ticket.status_changed ${label}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const supa = client();

  if (args.inventory) { await inventory(supa); return; }

  if (!args.class) {
    console.error('Specify --inventory or --class <A|C1|C2>. (B/C3/D are report-only.)');
    process.exit(2);
  }
  if (REPORT_ONLY.has(args.class)) {
    console.error(`Class ${args.class} is report-only (manual review via supervisor UI). Refusing to act.`);
    process.exit(2);
  }

  const mode = args.execute ? 'EXECUTE' : 'DRY-RUN';
  console.log(`\n=== Feedback Cleanup — class ${args.class} — ${mode} ===\n`);
  const open = await fetchOpenTickets(supa);

  if (args.class === 'A') {
    const clusters = classA(open);
    let n = 0;
    for (const c of clusters) {
      for (const dup of c.dups) { await applyDuplicate(supa, dup, c.canonical.id, args.execute); n++; }
    }
    console.log(`\n${args.execute ? 'Transitioned' : 'Would transition'} ${n} duplicate(s) across ${clusters.length} cluster(s).`);
  } else if (args.class === 'C1' || args.class === 'C2') {
    const cands = classC(open, args.class, args.staleDays);
    const reason = args.class === 'C1'
      ? `WONT_FIX: stale — no reporter response in ${args.staleDays}d`
      : `WONT_FIX: backlog-aged p3 (>${args.staleDays}d idle)`;
    for (const t of cands) await applyReject(supa, t, reason, args.execute);
    console.log(`\n${args.execute ? 'Rejected' : 'Would reject'} ${cands.length} stale ticket(s) (>${args.staleDays}d).`);
  } else {
    console.error(`Unknown class: ${args.class}`);
    process.exit(2);
  }

  if (!args.execute) console.log('\nDRY-RUN complete. Re-run with --execute to apply.\n');
}

main().catch((e) => { console.error('FATAL:', e?.message || e); process.exit(1); });
