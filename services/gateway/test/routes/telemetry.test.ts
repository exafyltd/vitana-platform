import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock dependencies
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

describe("Telemetry API Routes", () => {
  beforeAll(() => {
    process.env.SUPABASE_URL = "https://mock.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE = "mock-service-role-key";
  });

  afterAll(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => "Mock response text",
    });
  });

  const validEventPayload = {
    vtid: "VTID-123",
    layer: "backend",
    module: "auth",
    source: "test",
    kind: "test.event",
    status: "success",
    title: "Test Event",
  };

  describe("POST /event", () => {
    it("should return 401 when missing Authorization header", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid session token"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when token verification throws an error", async () => {
      (supabase.auth.getUser as jest.Mock).mockRejectedValueOnce(new Error("Network Error"));

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer error-token")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 202 when authenticated", async () => {
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
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /batch", () => {
    const batchPayload = [validEventPayload, validEventPayload];

    it("should return 401 when missing Authorization header", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(batchPayload);

      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer bad-token")
        .send(batchPayload);

      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 202 when authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(batchPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(res.body.count).toBe(2);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("GET /health", () => {
    it("should not require authentication and return 200", async () => {
      const res = await request(app).get("/api/v1/telemetry/health");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("GET /snapshot", () => {
    it("should not require authentication and return 200", async () => {
      // Mock fetch specifically for the snapshot endpoint (which does multiple fetch calls)
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ([]),
        text: async () => "",
      });

      const res = await request(app).get("/api/v1/telemetry/snapshot");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});