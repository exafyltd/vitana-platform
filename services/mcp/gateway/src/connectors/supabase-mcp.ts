class SupabaseMcpConnector {
  private supabaseUrl: string;
  private supabaseKey: string;

  constructor() {
    this.supabaseUrl = process.env.SUPABASE_URL || '';
    this.supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 
                       process.env.SUPABASE_SERVICE_ROLE || 
                       '';
    if (!this.supabaseUrl || !this.supabaseKey) {
      console.warn('⚠️  Supabase MCP: Missing configuration');
    }
  }

  async health() {
    if (!this.supabaseUrl || !this.supabaseKey) {
      return {
        status: 'error',
        message: 'Missing Supabase configuration',
      };
    }
    try {
      // Test connection with VtidLedger (PascalCase!)
      const response = await fetch(`${this.supabaseUrl}/rest/v1/VtidLedger?select=count&limit=1`, {
        headers: {
          'apikey': this.supabaseKey,
          'Authorization': `Bearer ${this.supabaseKey}`,
        },
      });
      if (!response.ok) {
        return { status: 'error', message: await response.text() };
      }
      return { status: 'ok', message: 'Connected' };
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
    // Return list of known tables
    return [
      'OasisEvent', 'VtidLedger', 'agent_keys', 'ai_conversations',
      'ai_memory', 'ai_messages', 'automation_rules', 'audit_events'
    ];
  }

  private async getTable(params: { table: string }) {
    // Query the table schema using REST API
    const response = await fetch(`${this.supabaseUrl}/rest/v1/${params.table}?limit=0`, {
      headers: {
        'apikey': this.supabaseKey,
        'Authorization': `Bearer ${this.supabaseKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return { table: params.table, message: 'Table accessible' };
  }

  private async readQuery(params: { query: string }) {
    throw new Error('Direct SQL queries not supported via REST API. Use specific table methods.');
  }
}

export const supabaseMcpConnector = new SupabaseMcpConnector();
