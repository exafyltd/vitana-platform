/**
 * product-gap-scanner-v1 (alpha)
 *
 * Sends a short context pack to Claude via the worker queue and asks it to
 * propose 1-3 concrete, specific extension opportunities. The goal is to
 * surface work that the heuristic scanners can't see — product holes,
 * missing features, user-visible rough edges.
 *
 * Rate-limited: runs at most once per day via a sentinel file at
 * services/gateway/dev-autopilot-state/last-product-gap-scan.txt. If the
 * last run was <24h ago, emit zero findings.
 *
 * Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE (enqueues a 'plan' task into
 * dev_autopilot_worker_queue). Returns no signals if those aren't set —
 * this scanner is opt-in and is marked `enabled: false` in the registry by
 * default.
 *
 * The worker picks up the task and routes it through the user's Claude
 * subscription; the gateway then ingests the result as findings in a
 * follow-up tick. This scanner's job is just to enqueue and sanity-check
 * the response shape.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readFileSafe } from './_shared.mjs';

export const meta = {
  scanner: 'product-gap-scanner-v1',
  signal_type: 'product_gap',
};

const SENTINEL = 'dev-autopilot-state/last-product-gap-scan.txt';
const MIN_INTERVAL_HOURS = Number.parseInt(process.env.PRODUCT_GAP_INTERVAL_HOURS || '24', 10);

function readSentinel(repoRoot) {
  const p = path.join(repoRoot, SENTINEL);
  const s = readFileSafe(p);
  if (!s) return null;
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function writeSentinel(repoRoot, ts) {
  const p = path.join(repoRoot, SENTINEL);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(ts));
  } catch { /* best effort — scanner runs in ephemeral CI, sentinel may not persist */ }
}

async function collectContext(repoRoot) {
  const summary = [];

  // Latest 3 OASIS events of each type (via Supabase REST if creds present).
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (url && key) {
    try {
      const r = await fetch(
        `${url}/rest/v1/oasis_events?select=topic,type,status,message,created_at&order=created_at.desc&limit=20`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      );
      if (r.ok) {
        const rows = await r.json();
        summary.push('## Recent OASIS events (latest 20)\n');
        for (const e of rows) summary.push(`- [${e.status}] ${e.topic || e.type} — ${e.message}`);
      }
    } catch { /* ignore */ }
  }

  // Open finding counts by scanner
  if (url && key) {
    try {
      const r = await fetch(
        `${url}/rest/v1/autopilot_recommendations?source_type=eq.dev_autopilot&status=eq.new&select=spec_snapshot`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      );
      if (r.ok) {
        const rows = await r.json();
        const counts = {};
        for (const row of rows) {
          const s = row.spec_snapshot?.scanner || 'unknown';
          counts[s] = (counts[s] || 0) + 1;
        }
        summary.push('\n## Open findings by scanner');
        for (const [k, v] of Object.entries(counts)) summary.push(`- ${k}: ${v}`);
      }
    } catch { /* ignore */ }
  }

  // Top-level directory map (so Claude knows the shape)
  summary.push('\n## Service structure');
  try {
    const services = fs.readdirSync(path.join(repoRoot, 'services'));
    for (const s of services) summary.push(`- services/${s}`);
  } catch { /* ignore */ }

  return summary.join('\n');
}

async function enqueueWorkerTask(prompt) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return { ok: false, error: 'SUPABASE not configured' };
  try {
    const res = await fetch(`${url}/rest/v1/dev_autopilot_worker_queue`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        kind: 'plan',
        finding_id: null,                          // not tied to a specific finding
        input_payload: {
          prompt,
          model: 'claude-sonnet-4-6',
          max_tokens: 2_000,
          notes: 'product-gap-scanner-v1',
        },
        status: 'pending',
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function run({ repoRoot }) {
  // Rate-limit
  const last = readSentinel(repoRoot);
  const now = Date.now();
  if (last && now - last < MIN_INTERVAL_HOURS * 60 * 60 * 1000) return [];

  // Build prompt
  const context = await collectContext(repoRoot);
  const prompt = [
    '# Dev Autopilot — product-gap scan',
    '',
    'You are an SRE + product engineer reviewing the Vitana platform for improvement',
    'opportunities that the heuristic scanners (missing-tests, safety-gap, rls-policy,',
    'schema-drift, route-auth, secret-exposure, npm-audit, stale-flag, dead-code) would',
    'not catch. Focus on:',
    '  - Missing observability / dashboards / alerts',
    '  - UX rough edges visible in recent OASIS events',
    '  - Feature gaps implied by incident patterns',
    '  - Small, specific extensions worth 1-2 days of autopilot work',
    '',
    'Output format — exactly this shape, nothing else:',
    '',
    '<<<FINDING>>>',
    'title: <short title, <=70 chars>',
    'file_path: <closest repo-relative path, or "general" if none>',
    'message: <one-sentence description>',
    'suggested_action: <concrete next step, 1-2 sentences>',
    '<<<END>>>',
    '',
    '(Repeat 1-3 times. If nothing worth flagging, emit zero blocks.)',
    '',
    '## Context',
    '',
    context,
  ].join('\n');

  // Enqueue — this scanner doesn't emit its own findings inline; the gateway
  // will ingest the worker's response in a separate service (not yet wired).
  // For now we just emit a single "product-gap scan enqueued" finding so
  // operators can see the scanner fired.
  const enq = await enqueueWorkerTask(prompt);
  writeSentinel(repoRoot, now);

  if (!enq.ok) return [];

  return [{
    type: 'product_gap',
    severity: 'low',
    file_path: 'scripts/ci/scanners/product-gap.mjs',
    line_number: 1,
    message: `product-gap-scanner-v1 enqueued a plan task for Claude. Results will surface as follow-up findings once the worker finishes.`,
    suggested_action: `Wait for the worker to respond. The follow-up findings will be ingested automatically once dev-autopilot-product-gap-ingester.ts is in place (not yet shipped — this scanner currently fires and forgets).`,
    scanner: 'product-gap-scanner-v1',
    raw: { enqueued_at: new Date().toISOString() },
  }];
}
