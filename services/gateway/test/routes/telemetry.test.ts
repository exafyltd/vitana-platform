import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";
import express from "express";
import request from "supertest";

// Mock supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock the devhub SSE broadcast to avoid failures during tests
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
// Mount router with a base path for consistency with actual app
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-role";
    
    // Mock global fetch for OASIS persistence
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      })
    ) as jest.Mock;
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validEvent = {
      vtid: "VTID-123",
      layer: "app",
      module: "test",
      source: "test-runner",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    };

    it("should return 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(expect.objectContaining({
        error: "Unauthorized",
      }));
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid session" },
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEvent);

      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validEvents = [{
      vtid: "VTID-123",
      layer: "app",
      module: "test",
      source: "test-runner",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    }];

    it("should return 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validEvents);

      expect(response.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validEvents);

      expect(response.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});