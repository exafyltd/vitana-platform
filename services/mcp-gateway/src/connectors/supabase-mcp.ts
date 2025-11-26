import { createClient, SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// VTID-0511: Hardened Supabase MCP Connector
// - No information_schema queries (not supported via PostgREST)
// - No raw SQL / exec_sql
// - Structured filters only
// - Table whitelist enforced
// - Column regex validation
// - Limit enforcement (default 50, max 500)
// =============================================================================

// Allowed tables whitelist
const ALLOWED_TABLES = [
  'oasis_events',
  'oasis_events_v1',
  'oasis_specs',
  'governance_rules',
  'governance_evaluations',
  'governance_violations',
  'governance_proposals',
] as const;

type AllowedTable = typeof ALLOWED_TABLES[number];

// Table metadata (since we can't query information_schema)
const TABLE_METADATA: Record<AllowedTable, { schema: string; description: string }> = {
  oasis_events: { schema: 'public', description: 'Core event stream for oasis operations' },
  oasis_events_v1: { schema: 'public', description: 'V1 oasis events table' },
  oasis_specs: { schema: 'public', description: 'Oasis specifications and configurations' },
  governance_rules: { schema: 'public', description: 'Governance rule definitions' },
  governance_evaluations: { schema: 'public', description: 'Governance evaluation results' },
  governance_violations: { schema: 'public', description: 'Governance violation records' },
  governance_proposals: { schema: 'public', description: 'Governance proposals' },
};

// Column name validation regex
const COLUMN_NAME_REGEX = /^[a-zA-Z0-9_]+$/;

// Limit constraints
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// Supported filter operators
const VALID_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in'] as const;
type FilterOperator = typeof VALID_OPERATORS[number];

// Filter definition
interface QueryFilter {
  column: string;
  op: FilterOperator;
  value: any;
}

// Order definition
interface QueryOrder {
  column: string;
  direction: 'asc' | 'desc';
}

// Read query params
interface ReadQueryParams {
  table: string;
  select?: string[];
  filters?: QueryFilter[];
  order?: QueryOrder[];
  limit?: number;
}

// Get table params
interface GetTableParams {
  table: string;
}

// =============================================================================
// Supabase Client
// =============================================================================

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables');
    }

    supabaseClient = createClient(url, key);
  }
  return supabaseClient;
}

// =============================================================================
// Validation Functions
// =============================================================================

function validateTableName(table: string): asserts table is AllowedTable {
  if (!ALLOWED_TABLES.includes(table as AllowedTable)) {
    throw new Error(`Table not in whitelist: ${table}. Allowed tables: ${ALLOWED_TABLES.join(', ')}`);
  }
}

function validateColumnName(column: string): void {
  if (!COLUMN_NAME_REGEX.test(column)) {
    throw new Error(`Invalid column name: ${column}. Column names must match /^[a-zA-Z0-9_]+$/`);
  }
}

function validateOperator(op: string): asserts op is FilterOperator {
  if (!VALID_OPERATORS.includes(op as FilterOperator)) {
    throw new Error(`Invalid filter operator: ${op}. Valid operators: ${VALID_OPERATORS.join(', ')}`);
  }
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined || limit === null) {
    return DEFAULT_LIMIT;
  }
  if (typeof limit !== 'number' || limit < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(limit, MAX_LIMIT);
}

// =============================================================================
// MCP Methods
// =============================================================================

/**
 * schema.list_tables - Returns metadata for all allowed tables
 */
async function listTables(): Promise<{ name: string; schema: string; description: string }[]> {
  return ALLOWED_TABLES.map((name) => ({
    name,
    schema: TABLE_METADATA[name].schema,
    description: TABLE_METADATA[name].description,
  }));
}

/**
 * schema.get_table - Returns table info including inferred columns from sample row
 */
async function getTable(params: GetTableParams): Promise<{
  name: string;
  schema: string;
  description: string;
  columns: string[];
}> {
  const { table } = params;

  if (!table) {
    throw new Error('Missing required parameter: table');
  }

  validateTableName(table);

  const client = getSupabaseClient();

  // Fetch a single row to infer column names
  const { data, error } = await client
    .from(table)
    .select('*')
    .limit(1);

  if (error) {
    throw new Error(`Failed to fetch table schema: ${error.message}`);
  }

  // Infer columns from the first row, or return empty array if table is empty
  const columns = data && data.length > 0 ? Object.keys(data[0]) : [];

  return {
    name: table,
    schema: TABLE_METADATA[table].schema,
    description: TABLE_METADATA[table].description,
    columns,
  };
}

/**
 * read_query - Execute a structured query with filters, ordering, and limits
 */
async function readQuery(params: ReadQueryParams): Promise<any[]> {
  const { table, select, filters, order, limit } = params;

  if (!table) {
    throw new Error('Missing required parameter: table');
  }

  // Validate table
  validateTableName(table);

  // Validate and build select clause
  let selectClause = '*';
  if (select && Array.isArray(select) && select.length > 0) {
    for (const col of select) {
      validateColumnName(col);
    }
    selectClause = select.join(',');
  }

  const client = getSupabaseClient();
  let query = client.from(table).select(selectClause);

  // Apply filters
  if (filters && Array.isArray(filters)) {
    for (const filter of filters) {
      if (!filter.column || filter.op === undefined || filter.value === undefined) {
        throw new Error('Invalid filter: must have column, op, and value');
      }

      validateColumnName(filter.column);
      validateOperator(filter.op);

      const { column, op, value } = filter;

      switch (op) {
        case 'eq':
          query = query.eq(column, value);
          break;
        case 'neq':
          query = query.neq(column, value);
          break;
        case 'gt':
          query = query.gt(column, value);
          break;
        case 'gte':
          query = query.gte(column, value);
          break;
        case 'lt':
          query = query.lt(column, value);
          break;
        case 'lte':
          query = query.lte(column, value);
          break;
        case 'like':
          query = query.like(column, value);
          break;
        case 'ilike':
          query = query.ilike(column, value);
          break;
        case 'in':
          if (!Array.isArray(value)) {
            throw new Error(`'in' operator requires an array value`);
          }
          query = query.in(column, value);
          break;
      }
    }
  }

  // Apply ordering
  if (order && Array.isArray(order)) {
    for (const o of order) {
      if (!o.column || !o.direction) {
        throw new Error('Invalid order: must have column and direction');
      }
      validateColumnName(o.column);
      if (o.direction !== 'asc' && o.direction !== 'desc') {
        throw new Error(`Invalid order direction: ${o.direction}. Must be 'asc' or 'desc'`);
      }
      query = query.order(o.column, { ascending: o.direction === 'asc' });
    }
  }

  // Apply limit
  const normalizedLimit = normalizeLimit(limit);
  query = query.limit(normalizedLimit);

  const { data, error } = await query;

  if (error) {
    throw new Error(`Query failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Health check - verify connection to Supabase
 */
async function health(): Promise<{ status: string; message: string }> {
  try {
    const client = getSupabaseClient();

    // Use a safe select from oasis_events to verify connectivity
    const { error } = await client
      .from('oasis_events')
      .select('id')
      .limit(1);

    if (error) {
      return { status: 'error', message: error.message };
    }

    return { status: 'ok', message: 'Connected to Supabase' };
  } catch (error: any) {
    return { status: 'error', message: error.message };
  }
}

// =============================================================================
// Connector Export
// =============================================================================

class SupabaseMcpConnector {
  async health() {
    return health();
  }

  async call(method: string, params: any) {
    switch (method) {
      case 'schema.list_tables':
        return listTables();

      case 'schema.get_table':
        return getTable(params);

      case 'read_query':
        return readQuery(params);

      default:
        throw new Error(`Unknown method: ${method}. Supported methods: schema.list_tables, schema.get_table, read_query`);
    }
  }
}

export const supabaseMcpConnector = new SupabaseMcpConnector();
