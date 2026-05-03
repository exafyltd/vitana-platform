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

jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  const originalEnv = process.env;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, SUPABASE_URL: "http://localhost", SUPABASE_SERVICE_ROLE: "test-role-key" };
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "test-123",
      layer: "core",
      module: "auth",
      source: "api",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    };

    it("should return 401 if no authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should proceed if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-1" } },
        error: null,
      });

      mockFetch.mockResolvedValue({
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
    const validBatchPayload = [{
      vtid: "test-123",
      layer: "core",
      module: "auth",
      source: "api",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    }];

    it("should return 401 if no authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatchPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validBatchPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should proceed if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-1" } },
        error: null,
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatchPayload);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});