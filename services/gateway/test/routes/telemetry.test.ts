import request from "supertest";
import express from "express";
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

// Mock devhub to avoid dependency issues during tests
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
    process.env.SUPABASE_URL = "https://mock.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE = "mock-service-key";
  });

  afterAll(() => {
    global.fetch = originalFetch;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock global fetch used for OASIS persistence
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => (""),
    } as any);
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VTID-123",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test.kind",
      status: "success",
      title: "Test Event"
    };

    it("should return 401 if no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if session token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 if valid session token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty("ok", true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validPayload = [{
      vtid: "VTID-123",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test.kind",
      status: "success",
      title: "Test Batch Event"
    }];

    it("should return 401 if no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if session token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 if valid session token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty("ok", true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});