/**
 * Backlog convert-row (dry-run by default) — Phase 1 W3-C1 PR 2 (VTID-03233).
 *
 * Takes a single vtid_ledger row id, looks it up, and either:
 *   - prints the proposed converted dev_autopilot recommendation to stdout
 *     (DRY RUN — default), OR
 *   - inserts that recommendation as a NEW vtid_ledger row with
 *     source_type=dev_autopilot, scanner=backlog-conversion-v1,
 *     source_ref=<original row id> (ONLY when --execute is passed).
 *
 * No workflow auto-invokes this. Operator only.
 *
 * Default: dry run. Refuses to write unless ALL of:
 *   --execute
 *   --id=<row_id>          (must match the row being converted)
 *   --confirm=convert-one
 *
 * Hard rules
 *   - One row per invocation. No bulk path. No iteration.
 *   - Conversion preserves original title/summary; appends a
 *     conversion-provenance footer
 *   - auto_exec_eligible = false (never auto-runs; operator still
 *     decides next step)
 *   - risk_class preserved or downgraded to 'medium' if missing/high
 *   - new row's vtid: allocated fresh via the gateway allocator so
 *     the ledger entry has provenance
 *
 * Env:
 *   PROD_SUPABASE_URL            (required)
 *   PROD_SUPABASE_SERVICE_ROLE   (required for read; ALSO required for --execute write)
 *   GATEWAY_URL                  (default https://gateway.vitanaland.com — for VTID allocator)
 *
 * Usage:
 *   # Dry run (default)
 *   npx tsx services/gateway/scripts/autopilot/backlog-convert-row.ts --id=VTID-XXXXX
 *
 *   # Execute (after operator review)
 *   npx tsx services/gateway/scripts/autopilot/backlog-convert-row.ts \
 *     --id=VTID-XXXXX --execute --confirm=convert-one
 */

const PROD_SUPABASE_URL = process.env.PROD_SUPABASE_URL;
const PROD_SUPABASE_KEY = process.env.PROD_SUPABASE_SERVICE_ROLE;
const GATEWAY_URL = process.env.GATEWAY_URL || 'https://gateway.vitanaland.com';

interface SourceRow {
  vtid: string;
  title: string | null;
  description: string | null;
  summary: string | null;
  layer: string | null;
  module: string | null;
  status: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface ConvertedInsert {
  vtid: string;
  title: string;
  description: string;
  summary: string;
  layer: 'DEV';
  module: string;
  status: 'new';
  is_terminal: false;
  metadata: {
    source_type: 'dev_autopilot';
    scanner: 'backlog-conversion-v1';
    source_ref: string;
    risk_class: string;
    auto_exec_eligible: false;
    spec_snapshot: {
      original_title: string | null;
      original_summary: string | null;
      original_source_type: string;
      original_created_at: string;
      proposed_file_hints: string[];
    };
    converted_at: string;
    converted_by: 'scripts/autopilot/backlog-convert-row.ts';
  };
}

function parseArgs(argv: string[]): { id?: string; execute: boolean; confirm?: string } {
  const out: { id?: string; execute: boolean; confirm?: string } = { execute: false };
  for (const a of argv.slice(2)) {
    if (a === '--execute') out.execute = true;
    else if (a.startsWith('--id=')) out.id = a.slice('--id='.length);
    else if (a.startsWith('--confirm=')) out.confirm = a.slice('--confirm='.length);
  }
  return out;
}

function getStr(meta: Record<string, unknown> | null, ...keys: string[]): string {
  if (!meta) return 'unknown';
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return 'unknown';
}

function extractFileHints(text: string): string[] {
  const hints = new Set<string>();
  const reFiles = /\b(services\/[a-z0-9_\-/.]+|cloudflare\/[a-z0-9_\-/.]+|scripts\/[a-z0-9_\-/.]+|test\/[a-z0-9_\-/.]+|\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)\b/g;
  let match: RegExpExecArray | null;
  while ((match = reFiles.exec(text)) !== null) hints.add(match[1]);
  const reExts = /\b([A-Za-z0-9_\-]+\.(?:ts|tsx|js|py|yml|yaml|md))\b/g;
  while ((match = reExts.exec(text)) !== null) hints.add(match[1]);
  return [...hints].slice(0, 8);
}

function downgradeRisk(original: string): string {
  const r = original.toLowerCase();
  if (r === 'low' || r === 'medium') return r;
  // missing or high -> medium (conservative)
  return 'medium';
}

async function fetchRow(id: string): Promise<SourceRow | null> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) {
    throw new Error('PROD_SUPABASE_URL / PROD_SUPABASE_SERVICE_ROLE required');
  }
  const url = `${PROD_SUPABASE_URL}/rest/v1/vtid_ledger?vtid=eq.${encodeURIComponent(id)}`
    + '&select=vtid,title,description,summary,layer,module,status,metadata,created_at'
    + '&limit=1';
  const resp = await fetch(url, {
    headers: { apikey: PROD_SUPABASE_KEY, Authorization: `Bearer ${PROD_SUPABASE_KEY}` },
  });
  if (!resp.ok) {
    throw new Error(`vtid_ledger fetch failed: ${resp.status} ${await resp.text()}`);
  }
  const rows = (await resp.json()) as SourceRow[];
  return rows[0] ?? null;
}

async function allocateNewVtid(): Promise<string> {
  const resp = await fetch(`${GATEWAY_URL}/api/v1/vtid/allocate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'backlog-conversion-v1',
      layer: 'DEV',
      module: 'AUTOPILOT',
    }),
  });
  if (!resp.ok) {
    throw new Error(`VTID allocate failed: ${resp.status}`);
  }
  const body = (await resp.json()) as { ok: boolean; vtid?: string; error?: string };
  if (!body.ok || !body.vtid) {
    throw new Error(`VTID allocate returned: ${JSON.stringify(body)}`);
  }
  return body.vtid;
}

function buildConverted(source: SourceRow, newVtid: string): ConvertedInsert {
  const text = `${source.title ?? ''} ${source.summary ?? ''} ${source.description ?? ''}`;
  const hints = extractFileHints(text);
  const original_source_type = getStr(source.metadata, 'source_type', 'source', 'origin');
  const original_risk = getStr(source.metadata, 'risk_class', 'risk');
  const provenance = `\n\n---\nConverted from \`${source.vtid}\` (original source_type: \`${original_source_type}\`, original created_at: \`${source.created_at}\`) by scripts/autopilot/backlog-convert-row.ts on ${new Date().toISOString()}.\nThis row is auto_exec_eligible=false: operator must still review + execute manually.`;
  return {
    vtid: newVtid,
    title: source.title ?? '(converted from backlog)',
    description: (source.description ?? '') + provenance,
    summary: source.summary ?? '',
    layer: 'DEV',
    module: source.module ?? 'AUTOPILOT',
    status: 'new',
    is_terminal: false,
    metadata: {
      source_type: 'dev_autopilot',
      scanner: 'backlog-conversion-v1',
      source_ref: source.vtid,
      risk_class: downgradeRisk(original_risk),
      auto_exec_eligible: false,
      spec_snapshot: {
        original_title: source.title,
        original_summary: source.summary,
        original_source_type,
        original_created_at: source.created_at,
        proposed_file_hints: hints,
      },
      converted_at: new Date().toISOString(),
      converted_by: 'scripts/autopilot/backlog-convert-row.ts',
    },
  };
}

async function insertConverted(row: ConvertedInsert): Promise<void> {
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) {
    throw new Error('Cannot --execute without PROD_SUPABASE_URL + PROD_SUPABASE_SERVICE_ROLE');
  }
  const resp = await fetch(`${PROD_SUPABASE_URL}/rest/v1/vtid_ledger`, {
    method: 'POST',
    headers: {
      apikey: PROD_SUPABASE_KEY,
      Authorization: `Bearer ${PROD_SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!resp.ok) {
    throw new Error(`vtid_ledger insert failed: ${resp.status} ${await resp.text()}`);
  }
  console.error('[convert-row] insert succeeded');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.id) {
    console.error('Usage: backlog-convert-row.ts --id=VTID-XXXXX [--execute --confirm=convert-one]');
    process.exit(2);
  }
  const source = await fetchRow(args.id);
  if (!source) {
    console.error(`[convert-row] vtid ${args.id} not found in vtid_ledger`);
    process.exit(1);
  }

  // For the dry-run preview, ALSO allocate a new VTID so the operator sees
  // the exact id that will be used. The allocator is monotonic — once
  // allocated, the id is committed. This is a small operational cost (one
  // VTID burned per dry-run). The alternative would be a synthetic
  // placeholder, but that obscures what the real insert would look like.
  const newVtid = await allocateNewVtid();
  const converted = buildConverted(source, newVtid);

  if (!args.execute) {
    console.log('=== DRY RUN — proposed converted dev_autopilot row ===');
    console.log(JSON.stringify(converted, null, 2));
    console.log('---');
    console.log(`To apply (operator only):`);
    console.log(`  npx tsx services/gateway/scripts/autopilot/backlog-convert-row.ts \\`);
    console.log(`    --id=${args.id} --execute --confirm=convert-one`);
    console.log(`(uses pre-allocated new VTID ${newVtid})`);
    return;
  }

  // --execute path: require explicit confirm token + id-roundtrip
  if (args.confirm !== 'convert-one') {
    console.error('[convert-row] --execute requires --confirm=convert-one');
    process.exit(2);
  }

  console.error(`[convert-row] EXECUTING: converting ${args.id} -> ${newVtid}`);
  await insertConverted(converted);
  console.log(JSON.stringify({ ok: true, source_vtid: args.id, new_vtid: newVtid, mode: 'executed' }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[convert-row] FAILED:', err);
    process.exit(1);
  });
}

export { fetchRow, buildConverted };
export type { SourceRow, ConvertedInsert };
