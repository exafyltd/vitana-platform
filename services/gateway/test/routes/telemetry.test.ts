import request from "supertest";
import express from "express";
import { router as telemetryRouter } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub to prevent SSE errors during tests
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", telemetryRouter);

describe("Telemetry Routes Authentication", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VTID-123",
      layer: "app",
      module: "auth",
      source: "client",
      kind: "auth.login",
      status: "success",
      title: "User logged in",
    };

    it("should return 401 if no Authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
    });

    it("should process request if authenticated", async () => {
      process.env.SUPABASE_SERVICE_ROLE = "dummy-svc-key";
      process.env.SUPABASE_URL = "http://dummy-supabase";

      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }) as jest.Mock;

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatchPayload = [{
      vtid: "VTID-123",
      layer: "app",
      module: "auth",
      source: "client",
      kind: "auth.login",
      status: "success",
      title: "User logged in",
    }];

    it("should return 401 if no Authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatchPayload);
      
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validBatchPayload);
      
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
    });

    it("should process batch if authenticated", async () => {
      process.env.SUPABASE_SERVICE_ROLE = "dummy-svc-key";
      process.env.SUPABASE_URL = "http://dummy-supabase";

      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }) as jest.Mock;

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatchPayload);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});