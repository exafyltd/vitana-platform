import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock Supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub to avoid external dependencies throwing errors in unit tests
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

describe("Telemetry Routes Authentication", () => {
  let app: express.Express;

  const validEventPayload = {
    vtid: "test-vtid",
    layer: "test-layer",
    module: "test-module",
    source: "test-source",
    kind: "test-kind",
    status: "success",
    title: "test-title",
  };

  beforeAll(() => {
    // Set required environment variables
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "mock-service-role";

    // Setup Express app with the router mapped to expected API path
    app = express();
    app.use(express.json());
    app.use("/api/v1/telemetry", router);

    // Mock global fetch used for OASIS insertion
    global.fetch = jest.fn();

    // Supress expected console output for clean test logs
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 when no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEventPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(res.body.detail).toBe("Missing or invalid Authorization header");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when an invalid token is provided", async () => {
      // Mock Supabase to return an error/no user for this token
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: null }, 
        error: { message: "Invalid token" } 
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEventPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 when a valid token is provided", async () => {
      // Mock Supabase to return a valid user payload
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: "user-123" } }, 
        error: null 
      });

      // Mock OASIS database fetch to return success
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEventPayload);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatchPayload = [validEventPayload];

    it("should return 401 when no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatchPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 when a valid token is provided", async () => {
      // Mock Supabase to return a valid user payload
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: "user-123" } }, 
        error: null 
      });

      // Mock OASIS database fetch to return success
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatchPayload);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(res.body.count).toBe(1);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});