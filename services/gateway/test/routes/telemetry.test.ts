import request from "supertest";
import express from "express";
import { router as telemetryRouter } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock Supabase
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub to prevent requires
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", telemetryRouter);

describe("Telemetry Routes", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env.SUPABASE_URL = "http://mock-supabase.local";
    process.env.SUPABASE_SERVICE_ROLE = "mock-service-key";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).fetch = jest.fn();
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VTID-123",
      layer: "app",
      module: "auth",
      source: "client",
      kind: "login",
      status: "success",
      title: "User logged in",
    };

    it("should return 401 when unauthenticated", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect((global as any).fetch).not.toHaveBeenCalled();
    });

    it("should return 401 with invalid token", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect((global as any).fetch).not.toHaveBeenCalled();
    });

    it("should proceed when authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      ((global as any).fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ id: "event-123" }),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect((global as any).fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validPayload = [{
      vtid: "VTID-123",
      layer: "app",
      module: "auth",
      source: "client",
      kind: "login",
      status: "success",
      title: "User logged in",
    }];

    it("should return 401 when unauthenticated", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect((global as any).fetch).not.toHaveBeenCalled();
    });

    it("should proceed when authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      ((global as any).fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ([{ id: "event-123" }]),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect((global as any).fetch).toHaveBeenCalled();
    });
  });
});