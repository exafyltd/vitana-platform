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

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", telemetryRouter);

describe("Telemetry API Auth Enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const validEventPayload = {
    vtid: "VT-123",
    layer: "core",
    module: "test",
    source: "test-runner",
    kind: "system.info",
    status: "success",
    title: "Test Event",
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("should return 401 when Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should return 401 when session token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-jwt-token")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should pass auth and proceed when session token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-jwt-token")
        .send(validEventPayload);

      // It reaches the internal logic which throws 500 because SUPABASE_URL isn't set in tests
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Gateway misconfigured");
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatchPayload = [validEventPayload];

    it("should return 401 when Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatchPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should return 401 when session token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-jwt-token")
        .send(validBatchPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should pass auth and proceed when session token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-jwt-token")
        .send(validBatchPayload);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Gateway misconfigured");
    });
  });
});