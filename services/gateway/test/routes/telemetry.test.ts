import request from "supertest";
import express from "express";
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

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    process.env.SUPABASE_URL = "http://localhost:8000";

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      })
    ) as jest.Mock;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "test-vtid",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test-kind",
      status: "success",
      title: "Test Event"
    };

    it("should return 401 when no Authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(supabase.auth.getUser).not.toHaveBeenCalled();
    });

    it("should return 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" }
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.detail).toBe("Invalid token");
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
    });

    it("should proceed (return 202) when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
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
    const validBatch = [{
      vtid: "test-vtid",
      layer: "test-layer",
      module: "test-module",
      source: "test-source",
      kind: "test-kind",
      status: "success",
      title: "Test Event"
    }];

    it("should return 401 when no Authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatch);

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(supabase.auth.getUser).not.toHaveBeenCalled();
    });

    it("should return 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" }
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validBatch);

      expect(response.status).toBe(401);
      expect(response.body.detail).toBe("Invalid token");
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
    });

    it("should proceed (return 202) when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatch);

      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});