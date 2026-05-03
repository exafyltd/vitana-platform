import express from "express";
import request from "supertest";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock supabase
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub to avoid runtime errors during require()
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_SERVICE_ROLE = "mock-service-role";
    process.env.SUPABASE_URL = "http://mock-supabase-url";
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VTID-001",
      layer: "app",
      module: "auth",
      source: "client",
      kind: "login",
      status: "success",
      title: "User logged in",
    };

    it("should return 401 when no authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should return 401 when authorization header is invalid", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Invalid Token")
        .send(validPayload);

      expect(response.status).toBe(401);
    });

    it("should return 401 when Supabase getUser returns error", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);

      expect(response.status).toBe(401);
    });

    it("should return 202 when user is authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validPayload = [
      {
        vtid: "VTID-001",
        layer: "app",
        module: "auth",
        source: "client",
        kind: "login",
        status: "success",
        title: "User logged in",
      }
    ];

    it("should return 401 when no authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validPayload);

      expect(response.status).toBe(401);
    });

    it("should return 202 when user is authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});