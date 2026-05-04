import express from "express";
import request from "supertest";
import { router as telemetryRouter } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock Supabase
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Prevent actual devhub SSE broadcasts in tests
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", telemetryRouter);

describe("Telemetry Routes Authentication", () => {
  const validEventPayload = {
    vtid: "VTID-TEST",
    layer: "test-layer",
    module: "test-module",
    source: "test-source",
    kind: "test.kind",
    status: "success",
    title: "Test Title",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as any;
    process.env.SUPABASE_SERVICE_ROLE = "test-svc-key";
    process.env.SUPABASE_URL = "http://test-supabase.local";
  });

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 if no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEventPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: null }, 
        error: new Error("Invalid token") 
      });
      
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer bad-token")
        .send(validEventPayload);
      
      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed to handler and return 202 if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: "user-123" } }, 
        error: null 
      });
      
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "event-123" }),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer good-token")
        .send(validEventPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("should return 401 if no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validEventPayload]);
      
      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: null }, 
        error: new Error("Invalid token") 
      });
      
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer bad-token")
        .send([validEventPayload]);
      
      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed to handler and return 202 if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ 
        data: { user: { id: "user-123" } }, 
        error: null 
      });
      
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ([{ id: "event-123" }]),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer good-token")
        .send([validEventPayload]);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});