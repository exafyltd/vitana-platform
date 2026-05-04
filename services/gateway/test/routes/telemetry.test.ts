import express from "express";
import request from "supertest";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock the Supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub because of require() side-effects inside the function
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

// Mock global fetch for OASIS persistence
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Provide necessary environment variables
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    process.env.SUPABASE_URL = "http://localhost:8000";
  });

  afterEach(() => {
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_URL;
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validEvent = {
      vtid: "VTID-TEST",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test-kind",
      status: "success",
      title: "Test event",
    };

    it("should return 401 if no authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return 401 if authorization token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return 202 and process event if auth is valid", async () => {
      // Mock successful auth
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "test-user-id" } },
        error: null,
      });

      // Mock successful fetch for OASIS persistence
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEvent);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatch = [{
      vtid: "VTID-TEST-BATCH",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test-kind",
      status: "success",
      title: "Test batch event",
    }];

    it("should return 401 if no authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatch);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return 401 if authorization token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validBatch);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return 202 and process batch if auth is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "test-user-id" } },
        error: null,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatch);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});