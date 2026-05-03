import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock the devhub broadcast to prevent warnings during testing
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn()
}), { virtual: true });

jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Auth Enforcement", () => {
  const validEvent = {
    vtid: "VTID-001",
    layer: "app",
    module: "auth",
    source: "frontend",
    kind: "user.login",
    status: "success",
    title: "User logged in",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";

    // Mock global fetch for Supabase HTTP requests
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => "ok",
    });
  });

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 without auth token", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(supabase.auth.getUser).not.toHaveBeenCalled();
    });

    it("should return 401 with an invalid token", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid session" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer bad-token")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should proceed to the handler with a valid token", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer good-token")
        .send(validEvent);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("should return 401 without auth token", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validEvent]);

      expect(res.status).toBe(401);
    });

    it("should proceed to the handler with a valid token", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer good-token")
        .send([validEvent]);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});