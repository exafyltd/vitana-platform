/**
 * Test setup file for Gateway service tests
 * Mocks external dependencies (Supabase, OASIS) for isolated testing
 * 
 * VTID: DEV-OASIS-0010
 * Updated: Match actual generateVtid implementation
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
process.env.GOOGLE_GEMINI_API_KEY = 'test-gemini-api-key-mock';
process.env.NODE_ENV = 'test';

// Mock VTID state management
const mockVtidStore: any[] = [];

// Layer map matching actual implementation
const layerMap: Record<string, string> = {
  'cicd': 'CICDL',
  'ai-core': 'AICOR',
  'ai-agent': 'AIAGE',
  'communication': 'COMMU',
  'gateway': 'GATEW',
  'oasis': 'OASIS',
  'mcp': 'MCPGW',
  'deploy': 'DEPLO',
  'test': 'TESTT',
  'governance': 'GENER',
  'deployment': 'DEPLO',
};

function generateMockVtid(taskFamily: string): string {
  const layer = layerMap[taskFamily.toLowerCase()] || 'GENER';
  
  // Find highest number for this layer
  const existingVtids = mockVtidStore
    .filter(v => v.vtid.startsWith(`DEV-${layer}-`))
    .map(v => parseInt(v.vtid.split('-')[2], 10))
    .filter(n => !isNaN(n));
  
  const nextNumber = existingVtids.length > 0 ? Math.max(...existingVtids) + 1 : 1;
  return `DEV-${layer}-${String(nextNumber).padStart(4, '0')}`;
}

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockClear();
  mockVtidStore.length = 0;
  
  // Default mock implementation for Supabase/OASIS calls
  mockFetch.mockImplementation((url: string | Request, options?: any) => {
    const urlString = typeof url === 'string' ? url : url.url;
    const method = options?.method || 'GET';
    const body = options?.body ? JSON.parse(options.body) : null;
    
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
          vtid: 'DEV-OASIS-0010',
          layer: 'OASIS',
          module: 'VTID',
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
    
        // Mock RPC next_vtid call - DEV-OASIS-0101
    if (urlString.includes('/rest/v1/rpc/next_vtid')) {
      if (method === 'POST' && body) {
        const family = body.p_family || 'DEV';
        const module = body.p_module || 'TEST';
        const year = new Date().getFullYear();
        
        // Find highest number for this family-module combo
        const prefix = family + '-' + module + '-' + year + '-';
        const existingVtids = mockVtidStore
          .filter(v => v.vtid && v.vtid.startsWith(prefix))
          .map(v => parseInt(v.vtid.split('-')[3], 10))
          .filter(n => !isNaN(n));
        
        const nextNumber = existingVtids.length > 0 ? Math.max(...existingVtids) + 1 : 1;
        const vtid = family + '-' + module + '-' + year + '-' + String(nextNumber).padStart(4, '0');
        
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => vtid,
          text: async () => JSON.stringify(vtid),
        } as any);
      }
    }

    
    // Mock RPC next_vtid call - DEV-OASIS-0101
    if (urlString.includes('/rest/v1/rpc/next_vtid')) {
      if (method === 'POST' && body) {
        const family = body.p_family || 'DEV';
        const module = body.p_module || 'TEST';
        const year = new Date().getFullYear();
        const prefix = family + '-' + module + '-' + year + '-';
        const existingVtids = mockVtidStore.filter(v => v.vtid && v.vtid.startsWith(prefix)).map(v => parseInt(v.vtid.split('-')[3], 10)).filter(n => !isNaN(n));
        const nextNumber = existingVtids.length > 0 ? Math.max(...existingVtids) + 1 : 1;
        const vtid = family + '-' + module + '-' + year + '-' + String(nextNumber).padStart(4, '0');
        return Promise.resolve({ ok: true, status: 200, json: async () => vtid, text: async () => JSON.stringify(vtid) } as any);
      }
    }
    // Mock VtidLedger queries
    if (urlString.includes('/rest/v1/VtidLedger')) {
      
      // CREATE - POST to VtidLedger
      if (method === 'POST' && body) {
        const vtid = generateMockVtid(body.task_family);
        const mockRecord = {
          id: crypto.randomUUID ? crypto.randomUUID() : 'test-id',
          vtid: vtid,
          task_family: body.task_family,
          task_type: body.task_type,
          description: body.description,
          status: body.status || 'pending',
          assigned_to: body.assigned_to || null,
          tenant: body.tenant,
          metadata: body.metadata || null,
          parent_vtid: body.parent_vtid || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        
        mockVtidStore.push(mockRecord);
        console.log("📦 Mock: Added", vtid, "to store, store now has", mockVtidStore.length, "items");
        
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          json: async () => [mockRecord],
          text: async () => JSON.stringify([mockRecord]),
          blob: async () => new Blob(),
          arrayBuffer: async () => new ArrayBuffer(0),
          formData: async () => new FormData(),
        } as any);
      }
      
      // GET specific VTID - query includes vtid=eq.VTID-YYYY-NNNN
      if (method === 'GET' && urlString.includes('vtid=eq.')) {
        const match = urlString.match(/vtid=eq\.([^&]+)/);
        const requestedVtid = match ? match[1] : '';
        
        console.log("🔍 Mock: Looking for", requestedVtid, "in store with", mockVtidStore.length, "items");
        console.log("🔍 Mock: Store contents:", mockVtidStore.map(v => v.vtid));
        
        const found = mockVtidStore.find(v => v.vtid === requestedVtid);
        console.log("🔍 Mock: Found?", !!found);
        
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          json: async () => found ? [found] : [],
          text: async () => JSON.stringify(found ? [found] : []),
          blob: async () => new Blob(),
          arrayBuffer: async () => new ArrayBuffer(0),
          formData: async () => new FormData(),
        } as any);
      }
      
      // UPDATE - PATCH to VtidLedger
      if (method === 'PATCH' && body) {
        const match = urlString.match(/vtid=eq\.([^&]+)/);
        const requestedVtid = match ? match[1] : '';
        
        const found = mockVtidStore.find(v => v.vtid === requestedVtid);
        if (found) {
          Object.assign(found, body, {
            updated_at: new Date().toISOString()
          });
          
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => [found],
            text: async () => JSON.stringify([found]),
            blob: async () => new Blob(),
            arrayBuffer: async () => new ArrayBuffer(0),
            formData: async () => new FormData(),
          } as any);
        }
        
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          json: async () => [],
          text: async () => '[]',
          blob: async () => new Blob(),
          arrayBuffer: async () => new ArrayBuffer(0),
          formData: async () => new FormData(),
        } as any);
      }
      
      // LIST - GET with optional filters (for latest VTID or list all)
      if (method === 'GET') {
        // Check if it's querying for latest VTID (like.DEV-LAYER-*)
        if (urlString.includes('like.DEV-')) {
          // Extract layer from query
          const match = urlString.match(/like\.DEV-([A-Z]+)-/);
          if (match) {
            const layer = match[1];
            const layerVtids = mockVtidStore.filter(v => v.vtid.startsWith(`DEV-${layer}-`));
            if (layerVtids.length > 0) {
              // Return the highest one
              const sorted = layerVtids.sort((a, b) => b.vtid.localeCompare(a.vtid));
              return Promise.resolve({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: new Headers(),
                json: async () => [sorted[0]],
                text: async () => JSON.stringify([sorted[0]]),
                blob: async () => new Blob(),
                arrayBuffer: async () => new ArrayBuffer(0),
                formData: async () => new FormData(),
              } as any);
            }
          }
          
          // No VTIDs found for this layer
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => [],
            text: async () => '[]',
            blob: async () => new Blob(),
            arrayBuffer: async () => new ArrayBuffer(0),
            formData: async () => new FormData(),
          } as any);
        }
        
        // Regular list query - return all from store
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          json: async () => mockVtidStore,
          text: async () => JSON.stringify(mockVtidStore),
          blob: async () => new Blob(),
          arrayBuffer: async () => new ArrayBuffer(0),
          formData: async () => new FormData(),
        } as any);
      }
    }

    // Mock vtid_ledger queries for /api/v1/tasks endpoint
    if (urlString.includes('/rest/v1/vtid_ledger')) {
      // POST - Create new VTID record (used by /api/v1/vtid/create)
      if (method === 'POST' && body) {
        const mockRecord = {
          id: crypto.randomUUID ? crypto.randomUUID() : 'test-vtid-id',
          vtid: body.vtid, // Use the vtid from the request body
          title: body.title,
          status: body.status || 'pending',
          tenant: body.tenant,
          layer: body.layer,
          module: body.module,
          summary: body.summary,
          metadata: body.metadata || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        mockVtidStore.push(mockRecord);
        console.log("📦 Mock vtid_ledger: Created", mockRecord.vtid);

        return Promise.resolve({
          ok: true,
          status: 201,
          statusText: 'Created',
          headers: new Headers(),
          json: async () => [mockRecord],
          text: async () => JSON.stringify([mockRecord]),
          blob: async () => new Blob(),
          arrayBuffer: async () => new ArrayBuffer(0),
          formData: async () => new FormData(),
        } as any);
      }

      if (method === 'GET') {
        // Return mock tasks data
        const mockTasks = [
          {
            vtid: 'DEV-OASIS-0001',
            layer: 'OASIS',
            module: 'PERSISTENCE',
            status: 'active',
            title: 'Mock Task 1',
            summary: 'Test task summary',
            assigned_to: null,
            metadata: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            vtid: 'DEV-CICDL-0002',
            layer: 'CICDL',
            module: 'GATEWAY',
            status: 'pending',
            title: 'Mock Task 2',
            summary: null,
            assigned_to: 'claude',
            metadata: { priority: 'high' },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ];

        // VTID-0527-C: Handle specific VTID lookup queries
        if (urlString.includes('vtid=eq.')) {
          const match = urlString.match(/vtid=eq\.([^&]+)/);
          const requestedVtid = match ? match[1] : '';

          // First check the mockVtidStore (for dynamically created VTIDs)
          const fromStore = mockVtidStore.find(v => v.vtid === requestedVtid);
          if (fromStore) {
            return Promise.resolve({
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: new Headers(),
              json: async () => [fromStore],
              text: async () => JSON.stringify([fromStore]),
              blob: async () => new Blob(),
              arrayBuffer: async () => new ArrayBuffer(0),
              formData: async () => new FormData(),
            } as any);
          }

          // Then check mockTasks
          const found = mockTasks.find(t => t.vtid === requestedVtid);
          return Promise.resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => found ? [found] : [],
            text: async () => JSON.stringify(found ? [found] : []),
            blob: async () => new Blob(),
            arrayBuffer: async () => new ArrayBuffer(0),
            formData: async () => new FormData(),
          } as any);
        }

        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          json: async () => mockTasks,
          text: async () => JSON.stringify(mockTasks),
          blob: async () => new Blob(),
          arrayBuffer: async () => new ArrayBuffer(0),
          formData: async () => new FormData(),
        } as any);
      }
    }

    // Default mock response
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

// Export mock helpers
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

console.log('✅ Test setup loaded - fetch mocked, env vars set');
