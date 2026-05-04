import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn()
    }
  }
}));

// Mock devhub broadcastEvent
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn()
}));

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => ""
    });
  });

  describe("Authentication Enforcement", () => {
    const validEvent = {
      vtid: "test-vtid",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test-kind",
      status: "success",
      title: "test-title"
    };

    it("POST /event should return 401 when missing token", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("POST /event should return 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token")
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("POST /event should proceed and return 202 when authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEvent);

      expect(res.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });

    it("POST /batch should return 401 when missing token", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validEvent]);

      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("POST /batch should proceed and return 202 when authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validEvent]);

      expect(res.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});