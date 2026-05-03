import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock dependencies
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

// Mock global fetch
global.fetch = jest.fn();

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Auth Enforcement", () => {
  beforeAll(() => {
    // Silence expected logs/errors during tests
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_SERVICE_ROLE = "mock-service-role";
    process.env.SUPABASE_URL = "http://mock-supabase.local";
  });

  const validPayload = {
    vtid: "VTID-123",
    layer: "core",
    module: "test",
    source: "jest",
    kind: "test.event",
    status: "info",
    title: "Test Event",
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 if no authorization token is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should return 401 if provided token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should proceed (202 Accepted) if token is valid and DB insert succeeds", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("should return 401 if no authorization token is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validPayload]);
      
      expect(res.status).toBe(401);
    });

    it("should return 401 if provided token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send([validPayload]);
      
      expect(res.status).toBe(401);
    });

    it("should proceed (202 Accepted) if token is valid and DB batch insert succeeds", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validPayload]);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("GET /api/v1/telemetry/health", () => {
    it("should remain publicly accessible", async () => {
      const res = await request(app).get("/api/v1/telemetry/health");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});