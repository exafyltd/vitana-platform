/**
 * Mock Supabase Client for Jest Testing
 * VTID: DEV-CICDL-0034
 * VT_LAYER: CICDL
 * VT_MODULE: GATEWAY
 * 
 * This mock replaces the real Supabase client in test environments,
 * eliminating external dependencies and enabling self-contained CI.
 */

// Mock data store
const mockDataStore = new Map<string, any[]>();

// Mock Supabase response structure
interface MockSupabaseResponse {
  data: any[] | null;
  error: Error | null;
  count: number | null;
  status: number;
  statusText: string;
}

/**
 * Mock Supabase Query Builder
 */
class MockQueryBuilder {
  private table: string;
  private filters: Array<{ field: string; value: any; operator: string }> = [];
  private selectFields: string = '*';
  private limitValue?: number;
  private orderByField?: string;
  private orderDirection: 'asc' | 'desc' = 'asc';

  constructor(table: string) {
    this.table = table;
  }

  select(fields: string = '*') {
    this.selectFields = fields;
    return this;
  }

  async insert(data: any | any[]) {
    const records = Array.isArray(data) ? data : [data];
    const tableData = mockDataStore.get(this.table) || [];
    
    const insertedRecords = records.map((record, index) => ({
      id: `mock-id-${Date.now()}-${index}`,
      created_at: new Date().toISOString(),
      ...record
    }));
    
    mockDataStore.set(this.table, [...tableData, ...insertedRecords]);
    
    return Promise.resolve({
      data: insertedRecords,
      error: null,
      count: insertedRecords.length,
      status: 201,
      statusText: 'Created'
    } as MockSupabaseResponse);
  }

  async update(data: any) {
    const tableData = mockDataStore.get(this.table) || [];
    const updatedRecords = tableData.map(record => {
      if (this.matchesFilters(record)) {
        return { ...record, ...data, updated_at: new Date().toISOString() };
      }
      return record;
    });
    
    mockDataStore.set(this.table, updatedRecords);
    
    return Promise.resolve({
      data: updatedRecords.filter(r => this.matchesFilters(r)),
      error: null,
      count: updatedRecords.length,
      status: 200,
      statusText: 'OK'
    } as MockSupabaseResponse);
  }

  async delete() {
    const tableData = mockDataStore.get(this.table) || [];
    const remainingRecords = tableData.filter(record => !this.matchesFilters(record));
    const deletedCount = tableData.length - remainingRecords.length;
    
    mockDataStore.set(this.table, remainingRecords);
    
    return Promise.resolve({
      data: null,
      error: null,
      count: deletedCount,
      status: 204,
      statusText: 'No Content'
    } as MockSupabaseResponse);
  }

  eq(field: string, value: any) {
    this.filters.push({ field, value, operator: 'eq' });
    return this;
  }

  neq(field: string, value: any) {
    this.filters.push({ field, value, operator: 'neq' });
    return this;
  }

  gt(field: string, value: any) {
    this.filters.push({ field, value, operator: 'gt' });
    return this;
  }

  gte(field: string, value: any) {
    this.filters.push({ field, value, operator: 'gte' });
    return this;
  }

  lt(field: string, value: any) {
    this.filters.push({ field, value, operator: 'lt' });
    return this;
  }

  lte(field: string, value: any) {
    this.filters.push({ field, value, operator: 'lte' });
    return this;
  }

  like(field: string, pattern: string) {
    this.filters.push({ field, value: pattern, operator: 'like' });
    return this;
  }

  in(field: string, values: any[]) {
    this.filters.push({ field, value: values, operator: 'in' });
    return this;
  }

  limit(count: number) {
    this.limitValue = count;
    return this;
  }

  order(field: string, options?: { ascending?: boolean }) {
    this.orderByField = field;
    this.orderDirection = options?.ascending === false ? 'desc' : 'asc';
    return this;
  }

  private matchesFilters(record: any): boolean {
    return this.filters.every(filter => {
      const recordValue = record[filter.field];
      
      switch (filter.operator) {
        case 'eq':
          return recordValue === filter.value;
        case 'neq':
          return recordValue !== filter.value;
        case 'gt':
          return recordValue > filter.value;
        case 'gte':
          return recordValue >= filter.value;
        case 'lt':
          return recordValue < filter.value;
        case 'lte':
          return recordValue <= filter.value;
        case 'like':
          return String(recordValue).includes(filter.value.replace(/%/g, ''));
        case 'in':
          return filter.value.includes(recordValue);
        default:
          return true;
      }
    });
  }

  then(resolve: (value: MockSupabaseResponse) => void) {
    const tableData = mockDataStore.get(this.table) || [];
    let results = tableData.filter(record => this.matchesFilters(record));
    
    // Apply ordering
    if (this.orderByField) {
      results.sort((a, b) => {
        const aVal = a[this.orderByField!];
        const bVal = b[this.orderByField!];
        const comparison = aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
        return this.orderDirection === 'asc' ? comparison : -comparison;
      });
    }
    
    // Apply limit
    if (this.limitValue) {
      results = results.slice(0, this.limitValue);
    }
    
    resolve({
      data: results,
      error: null,
      count: results.length,
      status: 200,
      statusText: 'OK'
    });
    
    return this;
  }
}

/**
 * Mock Supabase Client
 */
export const createMockSupabaseClient = () => ({
  from: (table: string) => new MockQueryBuilder(table),
  
  auth: {
    getSession: jest.fn().mockResolvedValue({
      data: { session: { user: { id: 'mock-user-id' } } },
      error: null
    }),
    signInWithPassword: jest.fn().mockResolvedValue({
      data: { user: { id: 'mock-user-id' }, session: { access_token: 'mock-token' } },
      error: null
    }),
    signOut: jest.fn().mockResolvedValue({ error: null }),
    onAuthStateChange: jest.fn().mockReturnValue({
      data: { subscription: { unsubscribe: jest.fn() } }
    })
  },
  
  storage: {
    from: (bucket: string) => ({
      upload: jest.fn().mockResolvedValue({
        data: { path: `${bucket}/mock-file-path` },
        error: null
      }),
      download: jest.fn().mockResolvedValue({
        data: new Blob(['mock file content']),
        error: null
      }),
      remove: jest.fn().mockResolvedValue({ data: null, error: null })
    })
  },
  
  functions: {
    invoke: jest.fn().mockResolvedValue({
      data: { success: true },
      error: null
    })
  }
});

/**
 * Mock OASIS Client for Telemetry
 */
export const createMockOasisClient = () => ({
  telemetry: {
    sendEvent: jest.fn().mockResolvedValue({
      success: true,
      eventId: `mock-event-${Date.now()}`,
      timestamp: new Date().toISOString()
    }),
    
    sendBatch: jest.fn().mockResolvedValue({
      success: true,
      processedCount: 0,
      failedCount: 0
    }),
    
    query: jest.fn().mockResolvedValue({
      data: [],
      total: 0,
      page: 1
    })
  },
  
  health: {
    check: jest.fn().mockResolvedValue({
      status: 'healthy',
      timestamp: new Date().toISOString()
    })
  }
});

/**
 * Utility to clear mock data between tests
 */
export const clearMockData = () => {
  mockDataStore.clear();
};

/**
 * Utility to seed mock data for tests
 */
export const seedMockData = (table: string, data: any[]) => {
  mockDataStore.set(table, data);
};

/**
 * Utility to get mock data for assertions
 */
export const getMockData = (table: string): any[] => {
  return mockDataStore.get(table) || [];
};

// Export for Jest
export default {
  createMockSupabaseClient,
  createMockOasisClient,
  clearMockData,
  seedMockData,
  getMockData
};
