/**
 * Test setup file for Gateway service tests
 * Mocks external dependencies (Supabase, OASIS) for isolated testing
 * 
 * VTID: DEV-CICDL-0034
 * 
 * IMPORTANT: This file runs before tests and mocks fetch globally
 */

// Mock node-fetch before any imports
jest.mock('node-fetch', () => jest.fn());

// Also mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Set required environment variables for tests
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/vitana_test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role-key-mock';
process.env.NODE_ENV = 'test';

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockClear();
  
  // Default mock implementation for Supabase/OASIS calls
  mockFetch.mockImplementation((url: string | Request, options?: any) => {
    const urlString = typeof url === 'string' ? url : url.url;
    
    // Mock OASIS persistence endpoint
    if (urlString.includes('/rest/v1/oasis_events')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => [{
          id: crypto.randomUUID ? crypto.randomUUID() : 'test-event-id',
          created_at: new Date().toISOString(),
          vtid: 'DEV-CICDL-0034',
          layer: 'CICDL',
          module: 'GATEWAY',
          source: 'test',
          kind: 'test.mock',
          status: 'success',
          title: 'Mock Event',
          ref: 'vt/test',
          link: null,
          meta: null,
        }],
        text: async () => 'OK',
        blob: async () => new Blob(),
        arrayBuffer: async () => new ArrayBuffer(0),
        formData: async () => new FormData(),
      } as any);
    }
    
    // Default mock response for any other fetch calls
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ success: true }),
      text: async () => 'OK',
      blob: async () => new Blob(),
      arrayBuffer: async () => new ArrayBuffer(0),
      formData: async () => new FormData(),
    } as any);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Export mock helpers for custom test scenarios
export const mockSupabaseResponse = (response: any) => {
  mockFetch.mockImplementationOnce(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => response,
      text: async () => JSON.stringify(response),
      blob: async () => new Blob(),
      arrayBuffer: async () => new ArrayBuffer(0),
      formData: async () => new FormData(),
    } as any)
  );
};

export const mockSupabaseError = (status: number, message: string) => {
  mockFetch.mockImplementationOnce(() =>
    Promise.resolve({
      ok: false,
      status,
      statusText: message,
      headers: new Headers(),
      json: async () => ({ error: message }),
      text: async () => message,
      blob: async () => new Blob(),
      arrayBuffer: async () => new ArrayBuffer(0),
      formData: async () => new FormData(),
    } as any)
  );
};

// Log to confirm setup loaded
console.log('✅ Test setup loaded - fetch mocked, env vars set');
