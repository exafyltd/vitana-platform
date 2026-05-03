import express from "express";
import request from "supertest";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub to prevent requires throwing if it's not present in tests
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    process.env.SUPABASE_URL = "http://localhost:8000";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => "",
    });
  });

  const validEventPayload = {
    vtid: "test-vtid",
    layer: "test-layer",
    module: "test-module",
    source: "test-source",
    kind: "test-kind",
    status: "success",
    title: "test-title"
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("returns 401 when no authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEventPayload);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ 
        error: "Unauthorized", 
        detail: "Missing or invalid Authorization header" 
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("returns 401 when authorization header is invalid/rejected by supabase", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEventPayload);

      expect(response.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("proceeds and returns 202 when authorization is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "test-user-id" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEventPayload);

      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("returns 401 when no authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validEventPayload]);

      expect(response.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("returns 401 when authorization header is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send([validEventPayload]);

      expect(response.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("proceeds and returns 202 when authorization is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "test-user-id" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validEventPayload]);

      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});