import request from "supertest";
import express from "express";
import { router as telemetryRouter } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

describe("Telemetry Routes Authentication", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use("/api/v1/telemetry", telemetryRouter);
    
    // Silence console during tests to avoid polluting the output logs
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    
    // Mock global fetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => "",
    } as any);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  const validEvent = {
    vtid: "VTID-1234",
    layer: "test-layer",
    module: "test-module",
    source: "test-source",
    kind: "test-kind",
    status: "success",
    title: "Test Event",
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 401 with invalid token", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid")
        .send(validEvent);
      expect(res.status).toBe(401);
    });

    it("proceeds with valid token", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid")
        .send(validEvent);
      
      expect(res.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatch = [validEvent];

    it("returns 401 without Authorization header", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatch);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 401 with invalid token", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid")
        .send(validBatch);
      expect(res.status).toBe(401);
    });

    it("proceeds with valid token", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid")
        .send(validBatch);
      
      expect(res.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});