/**
 * Test setup file for Gateway service tests
 * Mocks external dependencies (Supabase, OASIS) for isolated testing
 * 
 * VTID: DEV-CICDL-0034
 */

// Mock fetch globally for tests
global.fetch = jest.fn();

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
  
  // Default mock implementation for Supabase/OASIS calls
  (global.fetch as jest.Mock).mockImplementation((url: string, options?: any) => {
    // Mock OASIS persistence endpoint
    if (url.includes('/rest/v1/oasis_events')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [{
          id: 'test-event-id',
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
      });
    }
    
    // Default mock response
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
      text: async () => 'OK',
    });
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Export mock helper for custom test scenarios
export const mockSupabaseResponse = (response: any) => {
  (global.fetch as jest.Mock).mockImplementationOnce(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    })
  );
};

export const mockSupabaseError = (status: number, message: string) => {
  (global.fetch as jest.Mock).mockImplementationOnce(() =>
    Promise.resolve({
      ok: false,
      status,
      json: async () => ({ error: message }),
      text: async () => message,
    })
  );
};
