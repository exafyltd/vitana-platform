import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock Supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Setup Express app for testing
const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  const originalFetch = global.fetch;

  const validPayload = {
    vtid: "VTID-TEST",
    layer: "test-layer",
    module: "test-module",
    source: "test-source",
    kind: "test.event",
    status: "success",
    title: "Test Event Title",
  };

  beforeAll(() => {
    process.env.SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 when Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(supabase.auth.getUser).not.toHaveBeenCalled();
    });

    it("should return 401 when invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
    });

    it("should proceed (202 Accepted) when valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      // Mock fetch to simulate successful OASIS persistence
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "mock-id" }),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("should return 401 when Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validPayload]);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should proceed (202 Accepted) when valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      // Mock fetch to simulate successful batch OASIS persistence
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validPayload]);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
    });
  });
});