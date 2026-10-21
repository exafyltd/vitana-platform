/**
 * VTID-02640 — Tests for the planner's live-schema context module.
 *
 * Three units under test:
 *   1. extractTableNames    — regex-based table-name detection
 *   2. loadSchemaSnippets   — RPC fetch + per-table-set in-process cache
 *   3. formatSchemaBlock    — markdown rendering for the prompt
 *
 * Plus an integration check that buildPlanningPrompt includes the schema
 * block + the new anti-hallucination rules.
 */

import {
  extractTableNames,
  loadSchemaSnippets,
  formatSchemaBlock,
  _resetSchemaCacheForTests,
  type SchemaColumn,
} from '../src/services/dev-autopilot-schema-context';
import { buildPlanningPrompt } from '../src/services/dev-autopilot-planning';

const SUPA = { url: 'https://test.supabase.co', key: 'test_key' };
const ORIGINAL_FETCH = global.fetch;

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('extractTableNames', () => {
  it('detects Supabase JS .from() calls', () => {
    const code = `
      const { data } = await supabase.from('app_users').select('*');
      await supabase.from("memory_facts").insert({ ... });
    `;
    const out = extractTableNames(code);
    expect(out).toEqual(expect.arrayContaining(['app_users', 'memory_facts']));
  });

  it('detects .rpc() calls', () => {
    const code = `await supabase.rpc('write_fact', { ... });`;
    expect(extractTableNames(code)).toEqual(['write_fact']);
  });

  it('detects PostgREST URL paths /rest/v1/<table>', () => {
    const code = "fetch(`${supa.url}/rest/v1/oasis_events?topic=eq.foo`)";
    expect(extractTableNames(code)).toEqual(expect.arrayContaining(['oasis_events']));
  });

  it('detects raw SQL FROM/JOIN/UPDATE/INSERT INTO', () => {
    const sql = `
      SELECT * FROM tenants t
      JOIN user_tenants ut ON ut.tenant_id = t.tenant_id
      INSERT INTO memory_items (...) VALUES (...);
      UPDATE app_users SET vitana_id = $1;
    `;
    const out = extractTableNames(sql);
    expect(out).toEqual(
      expect.arrayContaining(['tenants', 'user_tenants', 'memory_items', 'app_users']),
    );
  });

  it('strips public. prefix on raw SQL', () => {
    expect(extractTableNames('SELECT * FROM public.dev_autopilot_runs'))
      .toEqual(['dev_autopilot_runs']);
  });

  it('drops SQL keywords that match the regex by accident', () => {
    // "FROM SELECT" should NOT yield "select" as a table name.
    const out = extractTableNames('SELECT a FROM (SELECT b FROM x) y');
    expect(out).toContain('x');
    expect(out).not.toContain('select');
  });

  it('returns empty for content with no table references', () => {
    expect(extractTableNames('console.log("hi");')).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(extractTableNames('')).toEqual([]);
  });

  it('deduplicates repeated names', () => {
    const out = extractTableNames(`
      .from('tenants')
      .from('tenants')
      FROM tenants
    `);
    expect(out).toEqual(['tenants']);
  });
});

describe('loadSchemaSnippets', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    _resetSchemaCacheForTests();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  const sampleRows: SchemaColumn[] = [
    {
      table_name: 'app_users',
      column_name: 'user_id',
      data_type: 'uuid',
      is_nullable: 'NO',
      column_default: 'gen_random_uuid()',
      ordinal_position: 1,
    },
    {
      table_name: 'app_users',
      column_name: 'vitana_id',
      data_type: 'text',
      is_nullable: 'YES',
      column_default: null,
      ordinal_position: 2,
    },
  ];

  it('returns [] for empty table list (no fetch)', async () => {
    const out = await loadSchemaSnippets(SUPA, []);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls the RPC with the sorted, deduped table list', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(sampleRows));
    await loadSchemaSnippets(SUPA, ['memory_facts', 'app_users', 'app_users']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('https://test.supabase.co/rest/v1/rpc/dev_autopilot_get_table_schema');
    const body = JSON.parse(call[1].body);
    expect(body.p_tables).toEqual(['app_users', 'memory_facts']);
  });

  it('caches results across repeated calls with the same table set', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(sampleRows));
    const a = await loadSchemaSnippets(SUPA, ['app_users']);
    const b = await loadSchemaSnippets(SUPA, ['app_users']);
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns [] gracefully when the RPC errors', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ error: 'boom' }, 500));
    const out = await loadSchemaSnippets(SUPA, ['x']);
    expect(out).toEqual([]);
  });

  it('returns [] when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const out = await loadSchemaSnippets(SUPA, ['x']);
    expect(out).toEqual([]);
  });
});

describe('formatSchemaBlock', () => {
  it('returns empty string for empty rows (so callers can concat unconditionally)', () => {
    expect(formatSchemaBlock([])).toBe('');
  });

  it('renders one section per table with column rows in ordinal order', () => {
    const rows: SchemaColumn[] = [
      { table_name: 'tenants', column_name: 'tenant_id', data_type: 'uuid', is_nullable: 'NO', column_default: null, ordinal_position: 1 },
      { table_name: 'app_users', column_name: 'vitana_id', data_type: 'text', is_nullable: 'YES', column_default: null, ordinal_position: 2 },
      { table_name: 'app_users', column_name: 'user_id', data_type: 'uuid', is_nullable: 'NO', column_default: null, ordinal_position: 1 },
    ];
    const md = formatSchemaBlock(rows);
    // Tables sorted alphabetically.
    expect(md.indexOf('### app_users')).toBeLessThan(md.indexOf('### tenants'));
    // Within app_users, user_id (pos 1) comes before vitana_id (pos 2).
    const usersBlock = md.slice(md.indexOf('### app_users'), md.indexOf('### tenants'));
    expect(usersBlock.indexOf('`user_id`')).toBeLessThan(usersBlock.indexOf('`vitana_id`'));
    // Includes the canonical column name we want the LLM to use.
    expect(md).toContain('`vitana_id`');
    // Includes the anti-hallucination header.
    expect(md).toMatch(/Live DB schema/);
    expect(md).toMatch(/probably hallucinating/);
  });
});

describe('buildPlanningPrompt — VTID-02640 schema-context wiring', () => {
  const finding = {
    id: 'f-1',
    title: 'Test',
    summary: 'sum',
    domain: 'dev',
    risk_class: 'low' as const,
    spec_snapshot: { file_path: 'services/gateway/src/x.ts' },
  };

  it('omits the schema-section HEADER when no schemaBlock is provided', () => {
    const out = buildPlanningPrompt(finding);
    // Match only the section header (anchored). The anti-hallucination
    // block intentionally references "Live DB schema section above" in
    // prose, so a loose regex would fire even with no schema attached.
    expect(out).not.toMatch(/^## Live DB schema \(read-only\)/m);
  });

  it('includes the schema block verbatim when provided', () => {
    const block = '## Live DB schema (read-only) — verify column names against this before citing them\n\n### foo';
    const out = buildPlanningPrompt(finding, undefined, undefined, undefined, undefined, block);
    expect(out).toContain(block);
  });

  it('always includes the anti-hallucination rules block', () => {
    const out = buildPlanningPrompt(finding);
    expect(out).toMatch(/Critical anti-hallucination rules/);
    expect(out).toMatch(/Never modify any file under .supabase\/migrations\//);
    expect(out).toMatch(/Never propose a column rename/);
    expect(out).toContain('PR #1086');
    expect(out).toContain('PR #1091');
  });

  it('puts schema context BEFORE the Output-format section so the LLM reads it first', () => {
    // The runPlan caller appends the file section AFTER buildPlanningPrompt's
    // output; we verify the schema block lands inside the prompt body and
    // before the Output-format trigger (the planner's Files-to-modify cue).
    const block = '## Live DB schema (read-only) — verify column names against this before citing them\n\n### bar';
    const out = buildPlanningPrompt(finding, undefined, undefined, undefined, undefined, block);
    const blockIdx = out.indexOf(block);
    const outputIdx = out.indexOf('## Output format');
    expect(blockIdx).toBeGreaterThan(-1);
    expect(outputIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeLessThan(outputIdx);
  });
});
