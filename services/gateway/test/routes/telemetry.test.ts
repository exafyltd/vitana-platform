import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock the supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub to prevent actual SSE broadcasts during tests
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry API Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as any;
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
  });

  describe("Authentication", () => {
    const validPayload = {
      vtid: "VT-123",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test.event",
      status: "success",
      title: "Test Event"
    };

    it("should return 401 for unauthenticated request to /event", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error", "Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 for invalid session token", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" }
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid_token")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid_token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should allow request with valid Authorization header", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({})
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid_token")
        .send(validPayload);
      
      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid_token");
      expect(global.fetch).toHaveBeenCalled();
    });

    it("should allow request with valid Supabase cookie", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({})
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Cookie", "sb-access-token=valid_cookie_token")
        .send(validPayload);
      
      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid_cookie_token");
      expect(global.fetch).toHaveBeenCalled();
    });

    it("should protect /batch route as well", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validPayload]);
      
      expect(response.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should allow /batch request with valid Authorization header", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({})
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid_token")
        .send([validPayload]);
      
      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid_token");
      expect(global.fetch).toHaveBeenCalled();
    });

    it("should leave /health read-only endpoint unauthenticated", async () => {
      const response = await request(app).get("/api/v1/telemetry/health");
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("ok", true);
    });
  });
});