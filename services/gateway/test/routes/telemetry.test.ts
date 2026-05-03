import request from "supertest";
import express from "express";
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

// Mock stage-mapping to avoid test failures due to complex dependencies
jest.mock("../../src/lib/stage-mapping", () => ({
  mapRawToStage: jest.fn().mockReturnValue("PLANNER"),
  normalizeStage: jest.fn(),
  isValidStage: jest.fn(),
  emptyStageCounters: jest.fn(),
  VALID_STAGES: ["PLANNER", "WORKER", "VALIDATOR", "DEPLOY"],
}));

// Global fetch mock
global.fetch = jest.fn() as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-role-key";
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VTID-123",
      layer: "app",
      module: "auth",
      source: "client",
      kind: "login",
      status: "success",
      title: "User login",
    };

    it("should return 401 if Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: null }, 
        error: { message: "Invalid token" } 
      });
      
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
    });

    it("should proceed (return 202) if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: "user-123" } }, 
        error: null 
      });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);
      
      expect(res.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validPayload = [{
      vtid: "VTID-123",
      layer: "app",
      module: "auth",
      source: "client",
      kind: "login",
      status: "success",
      title: "User login",
    }];

    it("should return 401 if Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validPayload);
      
      expect(res.status).toBe(401);
    });

    it("should return 202 if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: "user-123" } }, 
        error: null 
      });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);
      
      expect(res.status).toBe(202);
    });
  });
});