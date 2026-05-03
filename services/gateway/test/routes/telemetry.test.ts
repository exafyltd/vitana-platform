import express from "express";
import request from "supertest";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock the supabase client for auth verification
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn()
    }
  }
}));

// Mock global fetch for OASIS database inserts
global.fetch = jest.fn();

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Auth Enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    process.env.SUPABASE_URL = "http://test-supabase-url.com";
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VTID-TEST",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test.event",
      status: "success",
      title: "Test Event"
    };

    it("should return 401 if Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if session token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token")
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 202 if session token is valid and insert succeeds", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "test-user-id" } },
        error: null
      });

      // Mock the OASIS db insert successful response
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatchPayload = [{
      vtid: "VTID-TEST-1",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test.event.1",
      status: "success",
      title: "Test Event 1"
    }];

    it("should return 401 if Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatchPayload);
      
      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if session token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token")
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer bad-token")
        .send(validBatchPayload);
      
      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 202 if session token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "test-user-id" } },
        error: null
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ([{}])
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer good-token")
        .send(validBatchPayload);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});