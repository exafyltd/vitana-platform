#!/usr/bin/env node
/**
 * VTID-04565 — live evaluation of the developer assistant on STAGING.
 *
 * Sends each question of services/gateway/test/fixtures/developer-assistant-evals.json
 * to the Operator Console (POST /api/v1/operator/chat — the same brain the
 * Command Hub voice assistant shares since VTID-04564) and records, per answer:
 *   - which tools the turn called, and whether the expected first tool was among them;
 *   - whether the reply cites a source (a path, a VTID, a table, an event topic, a commit);
 *   - latency.
 *
 * Staging only: refuses any host that is not preview-aws-gateway.vitanaland.com
 * (CLAUDE.md: never test against production). Authenticates with the
 * VTID-04133 machine credential (X-Operator-Machine-Token), never a user password.
 *
 *   OPERATOR_MACHINE_AUTH_TOKEN=... node scripts/orb/eval-developer-assistant.mjs [--limit=10] [--out=report.json]
 *
 * Read-only by design: the questions ask about the system, and the tools the
 * answers use are read-only. dev_deep_dive questions run the real deep dive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '../../services/gateway/test/fixtures/developer-assistant-evals.json');
const STAGING = 'https://preview-aws-gateway.vitanaland.com';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const base = args.base || STAGING;
if (new URL(base).host !== new URL(STAGING).host) {
  console.error(`refusing ${base}: this eval runs against staging only`);
  process.exit(2);
}
const token = process.env.OPERATOR_MACHINE_AUTH_TOKEN;
if (!token) {
  console.error('OPERATOR_MACHINE_AUTH_TOKEN is not set');
  process.exit(2);
}

const SOURCE_CUE = /(\b[\w./-]+\.(ts|tsx|js|sql|yml|md)\b|VTID-\d{4,5}|\b[a-z_]+_(ledger|events|executions|memory|facts|items|policy)\b|\borb\.[a-z_.]+|\b[0-9a-f]{7,40}\b)/i;

const { questions } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const limit = Number(args.limit) || questions.length;
const results = [];
for (const q of questions.slice(0, limit)) {
  const started = Date.now();
  let row;
  try {
    const res = await fetch(`${base}/api/v1/operator/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Operator-Machine-Token': token },
      // VTID-04656: /api/v1/operator/chat validates threadId as a UUID; the
      // old `eval-<id>-<ts>` value was rejected with 400 on every question.
      body: JSON.stringify({ message: q.question, threadId: randomUUID() }),
    });
    const body = await res.json().catch(() => ({}));
    const tools = Array.isArray(body.toolResults) ? body.toolResults.map((t) => t.name || t.tool || '?') : [];
    const reply = typeof body.reply === 'string' ? body.reply : '';
    row = {
      id: q.id, domain: q.domain, http: res.status, ms: Date.now() - started,
      expected_tool: q.first_tool, tools, used_expected_tool: tools.includes(q.first_tool),
      cites_source: SOURCE_CUE.test(reply), reply_chars: reply.length,
    };
  } catch (e) {
    row = { id: q.id, domain: q.domain, error: String(e && e.message || e), ms: Date.now() - started };
  }
  results.push(row);
  console.log(JSON.stringify(row));
}

const ok = results.filter((r) => r.http === 200);
const summary = {
  base, at: new Date().toISOString(), asked: results.length, answered: ok.length,
  used_expected_tool: ok.filter((r) => r.used_expected_tool).length,
  cites_source: ok.filter((r) => r.cites_source).length,
  p50_ms: ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? null,
};
console.log(JSON.stringify({ summary }));
if (args.out) fs.writeFileSync(args.out, JSON.stringify({ summary, results }, null, 2));
