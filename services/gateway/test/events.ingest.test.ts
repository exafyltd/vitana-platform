import request from "supertest";
import express, { Express } from "express";
import { router as eventsRouter } from "../src/routes/events";

const createTestApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use("/", eventsRouter);
  return app;
};

describe("POST /api/v1/events/ingest (DEV-OASIS-0108)", () => {
  let app: Express;

  beforeEach(() => {
    app = createTestApp();
  });

  describe("Validation Errors (HTTP 400)", () => {
    it("should reject empty payload", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        ok: false,
        error: expect.stringContaining("vtid"),
        data: null,
      });
    });

    it("should reject missing vtid", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({
        type: "test.event",
        source: "test-service",
        status: "info",
        message: "Test",
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("vtid");
      expect(res.body.data).toBeNull();
    });

    it("should reject missing type", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "DEV-OASIS-0108",
        source: "test-service",
        status: "info",
        message: "Test",
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("type");
    });

    it("should reject missing source", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "DEV-OASIS-0108",
        type: "test.event",
        status: "info",
        message: "Test",
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("source");
    });

    it("should reject missing message", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "DEV-OASIS-0108",
        type: "test.event",
        source: "test-service",
        status: "info",
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("message");
    });

    it("should reject invalid status enum", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "DEV-OASIS-0108",
        type: "test.event",
        source: "test-service",
        status: "invalid",
        message: "Test",
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("status");
    });

    it("should reject empty vtid string", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "",
        type: "test.event",
        source: "test-service",
        status: "info",
        message: "Test",
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("vtid");
    });

    it("should reject non-object payload", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "DEV-OASIS-0108",
        type: "test.event",
        source: "test-service",
        status: "info",
        message: "Test",
        payload: "not an object",
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("payload");
    });
  });

  describe("Success Path (HTTP 200)", () => {
    beforeEach(() => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "test-uuid",
          vtid: "DEV-OASIS-0108",
          kind: "test.event",
          source: "test-service",
          status: "success",
          title: "Test message",
          meta: { foo: "bar" },
          created_at: "2025-11-15T10:00:00.000Z",
        }),
      } as unknown as Response);
    });

    it("should accept minimal valid payload", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "DEV-OASIS-0108",
        type: "test.event",
        source: "test-service",
        status: "info",
        message: "Test message",
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        error: null,
        data: {
          id: "test-uuid",
          vtid: "DEV-OASIS-0108",
          type: "test.event",
          source: "test-service",
          status: "success",
          message: "Test message",
          created_at: "2025-11-15T10:00:00.000Z",
          payload: { foo: "bar" },
        },
      });
    });

    it("should accept payload with optional fields", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "DEV-OASIS-0108",
        type: "test.event",
        source: "test-service",
        status: "success",
        message: "Test with payload",
        payload: { key: "value" },
        created_at: "2025-11-15T12:00:00.000Z",
      });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("should accept all valid status values", async () => {
      const statuses = ["info", "warning", "error", "success"];

      for (const status of statuses) {
        const res = await request(app).post("/api/v1/events/ingest").send({
          vtid: "DEV-OASIS-0108",
          type: "test.event",
          source: "test-service",
          status,
          message: `Status ${status}`,
        });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      }
    });
  });

  describe("Database Failure (HTTP 502)", () => {
    beforeEach(() => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Database error",
      } as unknown as Response);
    });

    it("should return 502 when database insert fails", async () => {
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "DEV-OASIS-0108",
        type: "test.event",
        source: "test-service",
        status: "info",
        message: "Test",
      });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        ok: false,
        error: "Database insert failed",
        data: null,
      });
    });
  });

  describe("Environment Configuration (HTTP 500)", () => {
    let originalSupabaseUrl: string | undefined;
    let originalSupabaseKey: string | undefined;

    beforeEach(() => {
      originalSupabaseUrl = process.env.SUPABASE_URL;
      originalSupabaseKey = process.env.SUPABASE_SERVICE_ROLE;
    });

    afterEach(() => {
      if (originalSupabaseUrl) process.env.SUPABASE_URL = originalSupabaseUrl;
      if (originalSupabaseKey)
        process.env.SUPABASE_SERVICE_ROLE = originalSupabaseKey;
    });

    it("should return 500 when SUPABASE_URL missing", async () => {
      delete process.env.SUPABASE_URL;
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "DEV-OASIS-0108",
        type: "test.event",
        source: "test-service",
        status: "info",
        message: "Test",
      });

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("misconfigured");
      expect(res.body.data).toBeNull();
    });

    it("should return 500 when SUPABASE_SERVICE_ROLE missing", async () => {
      delete process.env.SUPABASE_SERVICE_ROLE;
      const res = await request(app).post("/api/v1/events/ingest").send({
        vtid: "DEV-OASIS-0108",
        type: "test.event",
        source: "test-service",
        status: "info",
        message: "Test",
      });

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("misconfigured");
    });
  });
});
