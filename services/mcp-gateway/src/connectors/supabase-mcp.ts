import { createClient, SupabaseClient } from '@supabase/supabase-js';

const ALLOWED_TABLES = [
  'oasis_events',
  'oasis_events_v1',
  'oasis_specs',
  'governance_rules',
  'governance_evaluations',
  'governance_violations',
  'governance_proposals',
] as const;

type AllowedTable = (typeof ALLOWED_TABLES)[number];

type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in';

interface ReadQueryParams {
  table: string;
  select?: string[];
  filters?: Array<{
    column: string;
    op: FilterOp;
    value: any;
  }>;
  order?: Array<{
    column: string;
    direction: 'asc' | 'desc';
  }>;
  limit?: number;
}

function getSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase credentials are not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
    },
  });
}

function validateTableName(table: string): asserts table is AllowedTable {
  if (!ALLOWED_TABLES.includes(table as AllowedTable)) {
    throw new Error(`Table not in whitelist: ${table}`);
  }
}

function validateColumnName(column: string) {
  const re = /^[a-zA-Z0-9_]+$/;
  if (!re.test(column)) {
    throw new Error(`Invalid column name: ${column}`);
  }
}

function normalizeLimit(raw?: number): number {
  const defaultLimit = 50;
  const maxLimit = 500;
  if (raw == null || Number.isNaN(raw)) return defaultLimit;
  return Math.min(raw, maxLimit);
}

async function listTables() {
  return ALLOWED_TABLES.map((name) => ({
    name,
    schema: 'public',
    description: getTableDescription(name),
  }));
}

function getTableDescription(name: AllowedTable): string {
  switch (name) {
    case 'oasis_events':
      return 'Event logging for OASIS system';
    case 'oasis_events_v1':
      return 'Legacy OASIS events table';
    case 'oasis_specs':
      return 'Developer screen inventory specs';
    case 'governance_rules':
      return 'Governance rules';
    case 'governance_evaluations':
      return 'Governance evaluations';
    case 'governance_violations':
      return 'Governance violations';
    case 'governance_proposals':
      return 'Governance proposals';
    default:
      return '';
  }
}

async function getTable(params: { table: string }) {
  const table = params.table;
  validateTableName(table);

  const client = getSupabaseClient();
  const { data, error } = await client.from(table).select('*').limit(1);

  if (error) {
    throw new Error(`Failed to fetch table schema for ${table}: ${error.message}`);
  }

  const sample = (data && data[0]) || {};
  const columns = Object.keys(sample).map((name) => ({ name }));

  return {
    name: table,
    schema: 'public',
    columns,
  };
}

async function readQuery(params: ReadQueryParams) {
  if (!params.table) {
    throw new Error('Missing required parameter: table');
  }

  const table = params.table;
  validateTableName(table);

  const client = getSupabaseClient();

  // Start query
  let query = client.from(table).select(
    params.select && params.select.length > 0 ? params.select.join(',') : '*'
  );

  // Column name validation for select
  if (params.select) {
    for (const col of params.select) {
      validateColumnName(col);
    }
  }

  // Filters
  if (params.filters) {
    for (const f of params.filters) {
      validateColumnName(f.column);
      const value = f.value;

      switch (f.op) {
        case 'eq':
          query = query.eq(f.column, value);
          break;
        case 'neq':
          query = query.neq(f.column, value);
          break;
        case 'gt':
          query = query.gt(f.column, value);
          break;
        case 'gte':
          query = query.gte(f.column, value);
          break;
        case 'lt':
          query = query.lt(f.column, value);
          break;
        case 'lte':
          query = query.lte(f.column, value);
          break;
        case 'like':
          query = query.like(f.column, value);
          break;
        case 'ilike':
          query = query.ilike(f.column, value);
          break;
        case 'in':
          query = query.in(f.column, Array.isArray(value) ? value : [value]);
          break;
        default:
          throw new Error(`Unsupported filter operator: ${f.op}`);
      }
    }
  }

  // Order
  if (params.order) {
    for (const o of params.order) {
      validateColumnName(o.column);
      query = query.order(o.column, { ascending: o.direction === 'asc' });
    }
  }

  // Limit
  const limit = normalizeLimit(params.limit);
  query = query.limit(limit);

  const { data, error } = await query;

  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }

  return data ?? [];
}

async function health() {
  try {
    const client = getSupabaseClient();
    const { error } = await client.from('oasis_events').select('id').limit(1);
    if (error) {
      return { status: 'error', error: error.message };
    }
    return { status: 'ok' };
  } catch (err: any) {
    return { status: 'error', error: String(err.message || err) };
  }
}

export const supabaseMcpConnector = {
  name: 'supabase-mcp',
  async health() {
    return health();
  },
  async call(method: string, params: any) {
    switch (method) {
      case 'schema.list_tables':
        return listTables();
      case 'schema.get_table':
        return getTable(params || {});
      case 'read_query':
        return readQuery(params || {});
      default:
        throw new Error(`Unknown method for supabase-mcp: ${method}`);
    }
  },
};
