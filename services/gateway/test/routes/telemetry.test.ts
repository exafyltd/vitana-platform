import express from "express";
import request from "supertest";
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

// Mock devhub to avoid SSE broadcast errors in tests
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

// Mock fetch
global.fetch = jest.fn() as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Auth Enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_SERVICE_ROLE = "test-key";
    process.env.SUPABASE_URL = "http://test-url";
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "123",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test-kind",
      status: "success",
      title: "test-title",
    };

    it("should return 401 if no Authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(supabase.auth.getUser).not.toHaveBeenCalled();
    });

    it("should return 401 if Authorization header is invalid", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "InvalidToken")
        .send(validPayload);

      expect(response.status).toBe(401);
    });

    it("should return 401 if supabase.auth.getUser returns error", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer bad-token")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("bad-token");
    });

    it("should proceed and return 202 if user is authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-1" } },
        error: null,
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validPayload = [
      {
        vtid: "123",
        layer: "test-layer",
        module: "test-module",
        source: "test-source",
        kind: "test-kind",
        status: "success",
        title: "test-title",
      },
    ];

    it("should return 401 if no Authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validPayload);

      expect(response.status).toBe(401);
    });

    it("should proceed and return 202 if user is authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-1" } },
        error: null,
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ([]),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(response.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});