import { createClient, SupabaseClient } from '@supabase/supabase-js';

class SupabaseMcpConnector {
  private client: SupabaseClient;

  constructor() {
    const url = process.env.SUPABASE_URL || '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    this.client = createClient(url, key);
  }

  async health() {
    try {
      const { error } = await this.client.from('skills_mcp').select('count').limit(1);
      return { status: error ? 'error' : 'ok', message: error?.message || 'Connected' };
    } catch (error: any) {
      return { status: 'error', message: error.message };
    }
  }

  async call(method: string, params: any) {
    switch (method) {
      case 'schema.list_tables':
        return this.listTables();
      case 'schema.get_table':
        return this.getTable(params);
      case 'read_query':
        return this.readQuery(params);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private async listTables() {
    const { data, error } = await this.client
      .from('information_schema.tables')
      .select('table_name')
      .eq('table_schema', 'public');

    if (error) throw error;
    return data;
  }

  private async getTable(params: { table: string }) {
    const { data, error } = await this.client
      .from('information_schema.columns')
      .select('*')
      .eq('table_name', params.table);

    if (error) throw error;
    return data;
  }

  private async readQuery(params: { query: string }) {
    if (!params.query.trim().toLowerCase().startsWith('select')) {
      throw new Error('Only SELECT queries are allowed');
    }

    const { data, error } = await this.client.rpc('exec_sql', {
      query: params.query,
    });

    if (error) throw error;
    return data;
  }
}

export const supabaseMcpConnector = new SupabaseMcpConnector();
