/**
 * Tests for GET /api/v1/operator/deployments endpoint - VTID-0524
 * Validates JSON format, sorting, and no HTML/plain-text fallback
 */

import request from "supertest";
import app from "../src/index";

// Mock data for software_versions
const mockSoftwareVersions = [
  {
    swv_id: 'SWV-0003',
    created_at: '2025-11-30T10:15:00Z',
    git_commit: '3adcbcf1234567890abcdef1234567890abcdef12',
    status: 'success',
    service: 'gateway',
    environment: 'dev-sandbox',
  },
  {
    swv_id: 'SWV-0002',
    created_at: '2025-11-29T08:30:00Z',
    git_commit: '2bcdef1234567890abcdef1234567890abcdef12',
    status: 'success',
    service: 'oasis',
    environment: 'dev-sandbox',
  },
  {
    swv_id: 'SWV-0001',
    created_at: '2025-11-28T14:00:00Z',
    git_commit: '1abcdef234567890abcdef1234567890abcdef12',
    status: 'failure',
    service: 'gateway',
    environment: 'dev-sandbox',
  },
];

// Mock data for oasis_events (VTID mapping)
const mockOasisEvents = [
  {
    vtid: 'VTID-0510-SWV-0003',
    metadata: { swv_id: 'SWV-0003' },
  },
  {
    vtid: 'VTID-0510-SWV-0002',
    metadata: { swv_id: 'SWV-0002' },
  },
  {
    vtid: 'VTID-0510-SWV-0001',
    metadata: { swv_id: 'SWV-0001' },
  },
];

describe("GET /api/v1/operator/deployments - VTID-0524", () => {

  beforeEach(() => {
    // Reset fetch mock for each test
    (global.fetch as jest.Mock).mockClear();

    // Setup default mock implementation for deployments endpoint
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      // Mock software_versions query
      if (url.includes('/rest/v1/software_versions')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockSoftwareVersions,
          text: async () => JSON.stringify(mockSoftwareVersions),
        } as any);
      }

      // Mock oasis_events query for VTID mapping
      if (url.includes('/rest/v1/oasis_events') && url.includes('cicd.deploy.version.recorded')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockOasisEvents,
          text: async () => JSON.stringify(mockOasisEvents),
        } as any);
      }

      // Default mock response
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => '[]',
      } as any);
    });
  });

  // VTID-0525-B: API now returns plain array, not {ok: true, deployments: [...]}
  it("returns 200 with valid JSON format", async () => {
    const res = await request(app).get("/api/v1/operator/deployments");

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // VTID-0525-B: API returns plain array
    expect(res.body).toBeInstanceOf(Array);
  });

  it("returns deployments in correct VTID-0524 format", async () => {
    const res = await request(app).get("/api/v1/operator/deployments");

    expect(res.status).toBe(200);
    // VTID-0525-B: API returns plain array
    const deployments = res.body;
    expect(deployments).toBeInstanceOf(Array);
    expect(deployments.length).toBe(3);

    // Verify first deployment has all required fields
    const first = deployments[0];
    // Note: API returns swv_id, not swv
    expect(first).toHaveProperty('swv_id');
    expect(first).toHaveProperty('service');
    expect(first).toHaveProperty('environment');
    expect(first).toHaveProperty('status');
    expect(first).toHaveProperty('created_at');
    expect(first).toHaveProperty('git_commit');
  });

  it("returns deployments sorted by created_at DESC (most recent first)", async () => {
    const res = await request(app).get("/api/v1/operator/deployments");

    expect(res.status).toBe(200);
    // VTID-0525-B: API returns plain array
    const deployments = res.body;

    // Verify ordering - first should be most recent (by swv_id)
    expect(deployments[0].swv_id).toBe('SWV-0003');
    expect(deployments[1].swv_id).toBe('SWV-0002');
    expect(deployments[2].swv_id).toBe('SWV-0001');

    // Verify timestamps are in descending order
    for (let i = 0; i < deployments.length - 1; i++) {
      const current = new Date(deployments[i].created_at).getTime();
      const next = new Date(deployments[i + 1].created_at).getTime();
      expect(current).toBeGreaterThanOrEqual(next);
    }
  });

  it("returns JSON content type, not HTML or plain-text", async () => {
    const res = await request(app).get("/api/v1/operator/deployments");

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-type']).not.toMatch(/text\/html/);
    expect(res.headers['content-type']).not.toMatch(/text\/plain/);
  });

  it("handles nullable VTID gracefully", async () => {
    // Mock no oasis events (no VTID mappings)
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/rest/v1/software_versions')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockSoftwareVersions,
          text: async () => JSON.stringify(mockSoftwareVersions),
        } as any);
      }
      if (url.includes('/rest/v1/oasis_events')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [], // No VTID mappings
          text: async () => '[]',
        } as any);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => '[]',
      } as any);
    });

    const res = await request(app).get("/api/v1/operator/deployments");

    expect(res.status).toBe(200);
    // VTID-0525-B: API returns plain array
    const deployments = res.body;
    expect(deployments).toBeInstanceOf(Array);

    // All VTIDs should be null or undefined when no mapping exists
    deployments.forEach((d: any) => {
      expect(d.vtid == null).toBe(true); // null or undefined
    });
  });

  it("respects limit parameter", async () => {
    const res = await request(app).get("/api/v1/operator/deployments?limit=2");

    expect(res.status).toBe(200);
    // VTID-0525-B: API returns plain array
    expect(res.body).toBeInstanceOf(Array);
    // Note: The actual limiting happens in the database query
    // Here we just verify the endpoint accepts the parameter
  });

  it("returns empty array when no deployments exist", async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/rest/v1/software_versions')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
          text: async () => '[]',
        } as any);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => '[]',
      } as any);
    });

    const res = await request(app).get("/api/v1/operator/deployments");

    expect(res.status).toBe(200);
    // VTID-0525-B: API returns plain array
    expect(res.body).toEqual([]);
  });

  it("returns 502 when database query fails", async () => {
    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes('/rest/v1/software_versions')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: async () => 'Database error',
        } as any);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
        text: async () => '[]',
      } as any);
    });

    const res = await request(app).get("/api/v1/operator/deployments");

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Database query failed');
  });
});
