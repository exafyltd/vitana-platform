import express from "express";
import request from "supertest";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock Supabase
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

describe("Telemetry Routes Auth Enforcement", () => {
  let app: express.Application;
  let fetchSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.SUPABASE_SERVICE_ROLE = "test-svc-key";
    process.env.SUPABASE_URL = "http://localhost:8000";
    
    // Mock global fetch to prevent actual network calls during tests
    fetchSpy = jest.spyOn(global, "fetch").mockImplementation();

    app = express();
    app.use(express.json());
    app.use("/api/v1/telemetry", router);
  });

  afterAll(() => {
    fetchSpy.mockRestore();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const validPayload = {
    vtid: "VTID-123",
    layer: "app",
    module: "test",
    source: "test",
    kind: "test.event",
    status: "success",
    title: "Test Event",
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 when Authorization header is missing", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should return 401 when Supabase token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid JWT" },
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as any);

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);
      
      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatch = [validPayload];

    it("should return 401 when Authorization header is missing", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatch);
      
      expect(response.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should return 202 when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as any);

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatch);
      
      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});