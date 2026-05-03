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

// Mock devhub broadcasting to avoid actual imports
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-svc-key";
    
    // Mock global fetch for OASIS persistence
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => "",
    } as any);
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VTID-123",
      layer: "app",
      module: "test",
      source: "jest",
      kind: "test.event",
      status: "info",
      title: "Test Event",
    };

    it("should return 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 202 when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty("ok", true);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatch = [
      {
        vtid: "VTID-123",
        layer: "app",
        module: "test",
        source: "jest",
        kind: "test.event.1",
        status: "info",
        title: "Test Event 1",
      },
      {
        vtid: "VTID-123",
        layer: "app",
        module: "test",
        source: "jest",
        kind: "test.event.2",
        status: "success",
        title: "Test Event 2",
      }
    ];

    it("should return 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatch);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validBatch);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 202 when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatch);

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty("ok", true);
      expect(response.body).toHaveProperty("count", 2);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});