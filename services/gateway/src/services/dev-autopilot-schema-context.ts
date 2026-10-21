/**
 * Dev Autopilot — live DB schema context for the planner (VTID-02640).
 *
 * The planner LLM was hallucinating column names (most visibly in PR #1091
 * which proposed renaming `vitana_id` -> `vuid` across all auth code; the
 * `vuid` column does not exist). The model had no visibility into the live
 * schema and was inferring renames from filename patterns.
 *
 * This module fixes that by:
 *   1. Extracting table names referenced in the flagged file's content
 *      (`.from('x')`, `.rpc('y')`, SQL FROM/JOIN/UPDATE/INSERT INTO).
 *   2. Pre-fetching the schema for those tables via the new RPC
 *      `dev_autopilot_get_table_schema(p_tables text[])`.
 *   3. Formatting a markdown block the planner prompt can include verbatim.
 *
 * The fetch is cached in-process for SCHEMA_CACHE_TTL_MS so the planner
 * doesn't hit the DB on every plan generation, and the full pipeline is
 * best-effort: a fetch failure logs a warning and the planner runs without
 * schema context — never blocks plan generation.
 */

const LOG_PREFIX = '[dev-autopilot-schema-context]';

export interface SupaConfig { url: string; key: string; }

export interface SchemaColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  ordinal_position: number;
}

const SCHEMA_CACHE_TTL_MS = 60_000;

const cache = new Map<string, { rows: SchemaColumn[]; expires_at: number }>();

/**
 * Detect public-schema table names referenced in a TS / JS file body.
 *
 * Patterns covered:
 *   - .from('x') / .from("x")          (Supabase JS / Postgres-style)
 *   - .rpc('x')  / .rpc("x")
 *   - 'rest/v1/x' inside a URL string  (PostgREST direct calls)
 *   - SELECT/UPDATE/DELETE/INSERT INTO/FROM/JOIN <name>  (raw SQL strings)
 *
 * Names are filtered to the snake_case [a-z][a-z0-9_]+ shape we use for
 * tables, capped at 64 chars (Postgres limit), and de-duplicated. Unknown
 * names are still returned — the RPC will simply skip them server-side.
 */
export function extractTableNames(content: string): string[] {
  if (!content) return [];
  const found = new Set<string>();

  const tableShape = /^[a-z][a-z0-9_]{0,63}$/;

  const patterns: RegExp[] = [
    // Supabase JS .from('x') / .from("x") — name followed by ANY of
    // ) , ' " ` ; whitespace so we match both .from('x') and .from('x', opts).
    /\.from\(\s*['"`]([a-z][a-z0-9_]{0,63})['"`]/g,
    // Supabase JS .rpc('x'[, args])
    /\.rpc\(\s*['"`]([a-z][a-z0-9_]{0,63})['"`]/g,
    // PostgREST URL: /rest/v1/<table>?... or /rest/v1/<table>
    /\/rest\/v1\/([a-z][a-z0-9_]{0,63})(?:[?\s'"`/]|$)/g,
    // Raw SQL keywords. Word boundaries on both sides so we don't pick up
    // partial tokens; case-insensitive for SQL fragments inside `` literals.
    /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?([a-z][a-z0-9_]{0,63})\b/gi,
  ];

  for (const re of patterns) {
    for (const m of content.matchAll(re)) {
      const name = (m[1] || '').toLowerCase();
      if (name && tableShape.test(name)) {
        found.add(name);
      }
    }
  }

  // Drop SQL keywords that occasionally pass the regex (e.g. "FROM SELECT ...").
  const sqlKeywords = new Set([
    'select', 'where', 'and', 'or', 'as', 'on', 'using', 'natural',
    'inner', 'outer', 'left', 'right', 'full', 'cross', 'lateral',
    'limit', 'offset', 'order', 'group', 'having', 'union', 'all',
    'distinct', 'returning',
  ]);
  for (const kw of sqlKeywords) found.delete(kw);

  return Array.from(found);
}

/**
 * Fetch column metadata for the given tables. Cached per-table set
 * (hashed by sorted-comma-joined name list) for SCHEMA_CACHE_TTL_MS.
 */
export async function loadSchemaSnippets(
  supa: SupaConfig,
  tables: string[],
): Promise<SchemaColumn[]> {
  if (!tables || tables.length === 0) return [];
  const sorted = Array.from(new Set(tables)).sort();
  const cacheKey = sorted.join(',');

  const cached = cache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) {
    return cached.rows;
  }

  try {
    const res = await fetch(`${supa.url}/rest/v1/rpc/dev_autopilot_get_table_schema`, {
      method: 'POST',
      headers: {
        apikey: supa.key,
        Authorization: `Bearer ${supa.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_tables: sorted }),
    });
    if (!res.ok) {
      console.warn(`${LOG_PREFIX} schema RPC failed (${res.status}) for tables=${cacheKey}`);
      return [];
    }
    const rows = (await res.json()) as SchemaColumn[];
    if (!Array.isArray(rows)) return [];
    cache.set(cacheKey, { rows, expires_at: Date.now() + SCHEMA_CACHE_TTL_MS });
    return rows;
  } catch (err) {
    console.warn(`${LOG_PREFIX} schema fetch threw for tables=${cacheKey}:`, err);
    return [];
  }
}

/**
 * Render the schema rows as a markdown block the planner prompt can drop
 * in verbatim. Returns an empty string when there's nothing to render so
 * the caller can do `prompt += formatSchemaBlock(rows)` unconditionally.
 *
 * Format:
 *   ## Live DB schema (read-only) — verify column names against this
 *
 *   ### app_users
 *   | column | type | nullable | default |
 *   | ... |
 */
export function formatSchemaBlock(rows: SchemaColumn[]): string {
  if (!rows || rows.length === 0) return '';

  const byTable = new Map<string, SchemaColumn[]>();
  for (const row of rows) {
    const list = byTable.get(row.table_name) || [];
    list.push(row);
    byTable.set(row.table_name, list);
  }

  const lines: string[] = [
    ``,
    `## Live DB schema (read-only) — verify column names against this before citing them`,
    ``,
    `Source: \`information_schema.columns\` (\`public\` schema), fetched at plan-generation time.`,
    `If you cite a column name that is NOT in this section, you are probably hallucinating.`,
    `If a table you need is missing here, do not invent its columns — note the gap in the plan instead.`,
    ``,
  ];

  const tableNames = Array.from(byTable.keys()).sort();
  for (const table of tableNames) {
    const cols = byTable.get(table) || [];
    lines.push(`### ${table}`);
    lines.push(``);
    lines.push(`| column | type | nullable | default |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const col of cols.sort((a, b) => a.ordinal_position - b.ordinal_position)) {
      const def = col.column_default ? '`' + col.column_default.replace(/\|/g, '\\|') + '`' : '';
      lines.push(`| \`${col.column_name}\` | \`${col.data_type}\` | ${col.is_nullable} | ${def} |`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}

/**
 * Test-only hook: clear the in-process cache so unit tests start fresh.
 * Not exported for production use.
 */
export function _resetSchemaCacheForTests(): void {
  cache.clear();
}
