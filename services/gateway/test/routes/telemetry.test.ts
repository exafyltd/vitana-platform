import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock Supabase to bypass real auth checks
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock the SSE broadcast internally required in routes
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes", () => {
  const validEvent = {
    vtid: "test-vtid-123",
    layer: "core",
    module: "test-module",
    source: "test-source",
    kind: "test.event",
    status: "success",
    title: "Test Event Title",
  };

  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    
    originalFetch = global.fetch;
    originalEnv = process.env;
  });

  afterAll(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    process.env.SUPABASE_URL = "http://test-supabase-url.com";
    
    global.fetch = jest.fn();
  });

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 if Authorization header is missing", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error", "Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if session token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error", "Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should process the event and return 202 if authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEvent);

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty("ok", true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("should return 401 if Authorization header is missing", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validEvent]);

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error", "Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if session token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send([validEvent]);

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty("error", "Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should process the batch and return 202 if authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validEvent]);

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty("ok", true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});