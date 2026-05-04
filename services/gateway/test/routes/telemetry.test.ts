import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock supabase auth
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock optional devhub dependency inside the router
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

// Mock global fetch for Supabase HTTP requests
global.fetch = jest.fn();

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  const validEventPayload = {
    vtid: "VTID-TEST",
    layer: "test-layer",
    module: "test-module",
    source: "test-source",
    kind: "test.event",
    status: "success",
    title: "Test Event"
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "mock-service-role";
    
    // Default fetch mock to return success
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => "{}",
    });
  });

  describe("POST /api/v1/telemetry/event", () => {
    it("returns 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEventPayload);
        
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(supabase.auth.getUser).not.toHaveBeenCalled();
    });

    it("returns 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEventPayload);
        
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
    });

    it("proceeds and returns 202 when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEventPayload);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("returns 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validEventPayload]);
        
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("proceeds and returns 202 when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validEventPayload]);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(response.body.count).toBe(1);
    });
  });

  describe("GET /api/v1/telemetry/health", () => {
    it("does not require authentication", async () => {
      const response = await request(app).get("/api/v1/telemetry/health");
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });
});