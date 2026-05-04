import request from "supertest";
import express from "express";
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

// Mock devhub to prevent issues with missing files or side effects during tests
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Authentication", () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    process.env.SUPABASE_URL = "http://test-supabase-url.com";
  });

  afterAll(() => {
    global.fetch = originalFetch;
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_URL;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => "OK",
    });
  });

  const validEventPayload = {
    vtid: "test-vtid",
    layer: "test-layer",
    module: "test-module",
    source: "test-source",
    kind: "test-kind",
    status: "success",
    title: "test-title",
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 if no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "Unauthorized",
        detail: "Missing or invalid Authorization header",
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if invalid Authorization header format", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "InvalidTokenFormat")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if token is rejected by Supabase auth", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer bad-token")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: "Unauthorized",
        detail: "Invalid session token",
      });
      expect(supabase.auth.getUser).toHaveBeenCalledWith("bad-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed (202) if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer good-token")
        .send(validEventPayload);

      expect(res.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatchPayload = [validEventPayload];

    it("should return 401 if no Authorization header is provided", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatchPayload);

      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if token is rejected by Supabase auth", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "jwt expired" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer expired-token")
        .send(validBatchPayload);

      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed (202) if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer good-token")
        .send(validBatchPayload);

      expect(res.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});