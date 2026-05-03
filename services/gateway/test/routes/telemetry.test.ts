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

jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}));

// Mock global fetch for Supabase HTTP requests
global.fetch = jest.fn() as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-svc-key";
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VT-123",
      layer: "app",
      module: "test",
      source: "tester",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    };

    it("should return 401 if no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(res.body.detail).toBe("Missing Authorization header");
    });

    it("should return 401 if getUser returns an error", async () => {
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
      expect(res.body.detail).toBe("Invalid token");
    });

    it("should return 401 if token is empty after Bearer", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer ")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should proceed and return 202 if user is authenticated", async () => {
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
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validPayload = [{
      vtid: "VT-123",
      layer: "app",
      module: "test",
      source: "tester",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    }];

    it("should return 401 if no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validPayload);
      
      expect(res.status).toBe(401);
    });

    it("should proceed and return 202 if user is authenticated", async () => {
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
        .send(validPayload);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});