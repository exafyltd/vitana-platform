import express from "express";
import request from "supertest";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub to prevent require errors during testing if needed
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

describe("Telemetry Routes Auth Enforcement", () => {
  let app: express.Application;
  
  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/v1/telemetry", router);
    global.fetch = jest.fn();
    
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE = "test-svc-key";
  });

  const validEventPayload = {
    vtid: "VT-123",
    layer: "app",
    module: "core",
    source: "test",
    kind: "test.event",
    status: "success",
    title: "Test Event"
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("returns 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEventPayload);
        
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("returns 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: null }, 
        error: new Error("invalid token") 
      });
      
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEventPayload);
        
      expect(response.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("proceeds with a valid token and returns 202 on successful persistence", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: "user-123" } }, 
        error: null 
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEventPayload);

      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalledTimes(1);
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

    it("returns 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: null }, 
        error: new Error("invalid token") 
      });
      
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send([validEventPayload]);
        
      expect(response.status).toBe(401);
    });

    it("proceeds with a valid token and returns 202 on successful persistence", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: "user-123" } }, 
        error: null 
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validEventPayload]);

      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});