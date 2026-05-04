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
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry API Routes", () => {
  const originalFetch = global.fetch;

  beforeAll(() => {
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
  });

  const validEvent = {
    vtid: "test-123",
    layer: "app",
    module: "test",
    source: "jest",
    kind: "test.event",
    status: "success",
    title: "Test Event",
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 if missing Authorization header", async () => {
      const res = await request(app).post("/api/v1/telemetry/event").send(validEvent);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
    });

    it("should process event if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({}),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEvent);

      expect(res.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatch = [validEvent];

    it("should return 401 if missing Authorization header", async () => {
      const res = await request(app).post("/api/v1/telemetry/batch").send(validBatch);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validBatch);

      expect(res.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
    });

    it("should process batch if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce({}),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatch);

      expect(res.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});