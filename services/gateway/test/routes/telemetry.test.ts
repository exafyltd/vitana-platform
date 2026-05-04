import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

describe("Telemetry Routes Auth", () => {
  let app: express.Application;
  let mockFetch: jest.Mock;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use("/api/v1/telemetry", router);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";

    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;

    // Suppress console output to keep tests clean
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const validPayload = {
    vtid: "VTID-123",
    layer: "app",
    module: "test",
    source: "jest",
    kind: "test.event",
    status: "info",
    title: "Test Event"
  };

  it("should return 401 if no Authorization header is provided to /event", async () => {
    const res = await request(app)
      .post("/api/v1/telemetry/event")
      .send(validPayload);
    
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(res.body.detail).toBe("Missing Authorization header");
  });

  it("should return 401 if the token is invalid for /event", async () => {
    (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
      data: { user: null },
      error: { message: "Invalid session" }
    });

    const res = await request(app)
      .post("/api/v1/telemetry/event")
      .set("Authorization", "Bearer bad-token")
      .send(validPayload);
    
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
    expect(res.body.detail).toBe("Invalid session token");
  });

  it("should proceed and return 202 if the token is valid for /event", async () => {
    (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({})
    });

    const res = await request(app)
      .post("/api/v1/telemetry/event")
      .set("Authorization", "Bearer good-token")
      .send(validPayload);

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("should return 401 if no Authorization header is provided to /batch", async () => {
    const res = await request(app)
      .post("/api/v1/telemetry/batch")
      .send([validPayload]);
    
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("should return 202 if the token is valid for /batch", async () => {
    (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({})
    });

    const res = await request(app)
      .post("/api/v1/telemetry/batch")
      .set("Authorization", "Bearer good-token")
      .send([validPayload]);

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("should allow unauthenticated access to /health", async () => {
    const res = await request(app).get("/api/v1/telemetry/health");
    expect(res.status).toBe(200);
  });

  it("should allow unauthenticated access to /snapshot", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ([])
    });

    const res = await request(app).get("/api/v1/telemetry/snapshot");
    expect(res.status).toBe(200);
  });
});