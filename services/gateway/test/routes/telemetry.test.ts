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

// Mock devhub broadcast to prevent side effects
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Auth Enforcement", () => {
  const originalEnv = process.env;
  let fetchSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: "https://mock-supabase.local",
      SUPABASE_SERVICE_ROLE: "mock-service-role-key",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => (""),
      status: 200
    } as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const validEventPayload = {
    vtid: "VTID-TEST",
    layer: "core",
    module: "test",
    source: "test-runner",
    kind: "test.event",
    status: "success",
    title: "Test Event",
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 if no Authorization header is provided", async () => {
      const res = await request(app).post("/api/v1/telemetry/event").send(validEventPayload);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid session"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer bad-token")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEventPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatchPayload = [validEventPayload];

    it("should return 401 if no Authorization header is provided", async () => {
      const res = await request(app).post("/api/v1/telemetry/batch").send(validBatchPayload);
      expect(res.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid session"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer bad-token")
        .send(validBatchPayload);

      expect(res.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatchPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});