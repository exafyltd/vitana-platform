import express from "express";
import request from "supertest";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock the Supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn()
    }
  }
}));

// Mock devhub broadcast to prevent unresolvable dependencies in test execution
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn()
}));

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup env vars required by the route handlers
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-svc-key";

    // Mock global fetch for Supabase HTTP requests
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("")
      })
    ) as jest.Mock;
  });

  const validEvent = {
    vtid: "VTID-123",
    layer: "layer1",
    module: "module1",
    source: "source1",
    kind: "test.event",
    status: "info",
    title: "Test Event"
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("returns 401 when no authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 401 when invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token")
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
    });

    it("returns 202 when valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-1" } },
        error: null
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEvent);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("returns 401 when no authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validEvent]);

      expect(res.status).toBe(401);
    });

    it("returns 401 when invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Expired token")
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer expired-token")
        .send([validEvent]);

      expect(res.status).toBe(401);
    });

    it("returns 202 when valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-1" } },
        error: null
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validEvent]);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});