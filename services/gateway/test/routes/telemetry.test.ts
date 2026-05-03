import request from "supertest";
import express from "express";
import { router as telemetryRouter } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock supabase
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub to prevent issues during testing
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

// Mock global fetch for oasis_events
global.fetch = jest.fn();

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", telemetryRouter);

describe("Telemetry Routes Authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-role";
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
      task_stage: "PLANNER"
    };

    it("should return 401 when missing authorization header", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should return 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: null }, 
        error: { message: "Invalid token" } 
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should proceed and return 202 when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: "user-123" } }, 
        error: null 
      });
      
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "event-123" }),
      });

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
    const validPayload = [{
      vtid: "VTID-123",
      layer: "app",
      module: "auth",
      source: "client",
      kind: "auth.login",
      status: "success",
      title: "User logged in",
      task_stage: "PLANNER"
    }];

    it("should return 401 when missing authorization header", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should return 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: null }, 
        error: { message: "Invalid token" } 
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should proceed and return 202 when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: "user-123" } }, 
        error: null 
      });
      
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ([{ id: "event-123" }]),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);
      
      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});