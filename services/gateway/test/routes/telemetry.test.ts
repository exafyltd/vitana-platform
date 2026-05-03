import request from "supertest";
import express from "express";
import { router as telemetryRouter } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn()
    }
  }
}));

// Mock devhub to prevent any side effects if it gets evaluated
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn()
}), { virtual: true });

describe("Telemetry Routes Authentication", () => {
  let app: express.Express;
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use("/api/v1/telemetry", telemetryRouter);
    
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => ""
    });
  });

  const validEvent = {
    vtid: "VTID-001",
    layer: "core",
    module: "test",
    source: "test-runner",
    kind: "event.test",
    status: "success",
    title: "Test Event"
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 when no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
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

    it("should proceed and return 202 when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "test-user-id" } },
        error: null
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEvent);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatch = [validEvent];

    it("should return 401 when no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatch);
      
      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token")
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validBatch);
      
      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "test-user-id" } },
        error: null
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatch);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});