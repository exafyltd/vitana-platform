#!/usr/bin/env -S node
/**
 * VTID-03889 — one-time backfill: CLAUDE.md's CHANGE LOG -> dev_agent_memory.
 *
 * The Command Hub Operator had no memory of its own; dev_agent_memory (this
 * VTID) is the fix. A brand-new table with zero rows is still a cold start,
 * and CLAUDE.md's own CHANGE LOG table is the single richest source of real
 * engineering history already sitting in this repo -- each row is a real
 * VTID's root cause, fix, and verification status, already written by prior
 * sessions. This script parses that table and writes one dev_agent_memory
 * row per entry so the Operator's very first recall query already has real
 * history to draw on, instead of starting from nothing.
 *
 * Scope: CLAUDE.md's own inline table only (currently the trailing ~2 weeks
 * per the file's own note above the table). docs/CHANGELOG-ARCHIVE.md holds
 * ~67 older entries and is a deliberate follow-up, not done here -- the two
 * files have a different format history and mixing them into one parser
 * risked a fragile regex that silently drops rows from either shape.
 *
 * Every row is written with category='task_outcome' and source='backfill' --
 * a lightweight decision/incident/gotcha classifier over free-text prose
 * would misfire more often than a flat, honest label would help; live
 * Operator writes going forward use the specific categories.
 *
 * Idempotent: re-running skips any VTID that already has a source='backfill'
 * row (checked by direct query before embedding, so a re-run costs no
 * Bedrock calls for rows already done).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... BEDROCK_ROLE_ARN=... \
 *     npx tsx scripts/backfill-dev-memory-from-claude-md.ts [--dry-run]
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getSupabase, supa } from '../src/services/dev-autopilot-execute';
import { writeDevMemory } from '../src/services/dev-agent-memory';

// __dirname (CommonJS -- this package has no "type": "module" and
// tsconfig.json targets "module": "commonjs") rather than import.meta.url,
// so this file can be imported directly by a jest unit test for
// parseChangelog() without ts-jest choking on ESM-only syntax.
const REPO_ROOT = resolve(__dirname, '../../..');
const CLAUDE_MD_PATH = join(REPO_ROOT, 'CLAUDE.md');

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_CONTENT_CHARS = 12_000;

interface ChangelogRow {
  date: string;
  vtid: string | null;
  title: string;
  content: string;
}

function stripMarkdown(s: string): string {
  return s.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function extractTitle(changeText: string): string {
  const boldMatch = changeText.match(/\*\*(.+?)\*\*/);
  const raw = boldMatch ? boldMatch[1] : changeText;
  const clean = stripMarkdown(raw);
  return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
}

export function parseChangelog(claudeMdText: string): ChangelogRow[] {
  const headerIdx = claudeMdText.indexOf('## CHANGE LOG');
  if (headerIdx === -1) return [];
  const section = claudeMdText.slice(headerIdx);

  const rows: ChangelogRow[] = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|(.*)\|\s*([^|]*)\s*\|\s*$/);
    if (!m) continue;
    const [, date, changeRaw, vtidRaw] = m;
    const vtidMatch = vtidRaw.match(/VTID-\d{4,5}/);
    const changeText = changeRaw.trim();
    const content = stripMarkdown(`[${date}] ${changeText}`);
    rows.push({
      date,
      vtid: vtidMatch ? vtidMatch[0] : null,
      title: extractTitle(changeText),
      content: content.length > MAX_CONTENT_CHARS ? `${content.slice(0, MAX_CONTENT_CHARS)}...` : content,
    });
  }
  return rows;
}

async function alreadyBackfilled(s: { url: string; key: string }, vtid: string): Promise<boolean> {
  const r = await supa<Array<{ id: string }>>(
    s,
    `/rest/v1/dev_agent_memory?repo=eq.vitana-platform&source=eq.backfill&vtid=eq.${encodeURIComponent(vtid)}&select=id&limit=1`,
    { method: 'GET' },
  );
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

async function main() {
  const claudeMdText = readFileSync(CLAUDE_MD_PATH, 'utf-8');
  const rows = parseChangelog(claudeMdText);
  console.log(`Parsed ${rows.length} CHANGE LOG entries from ${CLAUDE_MD_PATH}`);

  if (DRY_RUN) {
    for (const row of rows) {
      console.log(`  [${row.vtid ?? 'no-vtid'}] ${row.title} (${row.content.length} chars)`);
    }
    console.log('--dry-run: no writes performed.');
    return;
  }

  const s = getSupabase();
  if (!s) {
    console.error('SUPABASE_URL/SUPABASE_SERVICE_ROLE not set. Aborting.');
    process.exit(1);
  }

  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (row.vtid && (await alreadyBackfilled(s, row.vtid))) {
      console.log(`  skip (already backfilled): ${row.vtid}`);
      skipped++;
      continue;
    }

    const result = await writeDevMemory({
      repo: 'vitana-platform',
      category: 'task_outcome',
      title: row.title,
      content: row.content,
      vtid: row.vtid ?? undefined,
      importance: 60,
      source: 'backfill',
      tags: ['changelog-backfill'],
    });

    if (result.ok) {
      console.log(`  wrote ${row.vtid ?? 'no-vtid'} -> ${result.id}`);
      written++;
    } else {
      console.error(`  FAILED ${row.vtid ?? 'no-vtid'}: ${result.error}`);
      failed++;
    }
  }

  console.log(`\nDone. written=${written} skipped=${skipped} failed=${failed} total=${rows.length}`);
  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
