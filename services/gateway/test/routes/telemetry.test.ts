import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock Supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn()
    }
  }
}));

const app = express();
app.use(express.json());
// Mount router at expected path
app.use("/api/v1/telemetry", router);

describe("Telemetry API Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";

    // Mock global fetch for internal API calls to Supabase REST endpoints
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      })
    ) as jest.Mock;
  });

  const validEvent = {
    vtid: "test-vtid",
    layer: "test-layer",
    module: "test-module",
    source: "test-source",
    kind: "test.event",
    status: "success",
    title: "Test Event"
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "invalid token" }
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer bad-token")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(supabase.auth.getUser).toHaveBeenCalledWith("bad-token");
    });

    it("returns 202 when valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEvent);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validEvent]);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "invalid token" }
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer bad-token")
        .send([validEvent]);

      expect(res.status).toBe(401);
    });

    it("returns 202 when valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validEvent]);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
    });
  });
});