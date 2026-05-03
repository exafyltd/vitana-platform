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

describe("Telemetry Routes Auth Enforcement", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // Middleware to mock cookie parsing capabilities if accessed by the middleware
    app.use((req, res, next) => {
      (req as any).cookies = {};
      next();
    });
    app.use("/api/v1/telemetry", router);

    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => "OK",
    });
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    process.env.SUPABASE_URL = "http://localhost:8000";
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VTID-123",
      layer: "app",
      module: "test",
      source: "jest",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    };

    it("returns 401 when missing Authorization header", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(supabase.auth.getUser).not.toHaveBeenCalled();
    });

    it("returns 401 when token is invalid", async () => {
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
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
    });

    it("proceeds when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(res.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatchPayload = [
      {
        vtid: "VTID-123",
        layer: "app",
        module: "test",
        source: "jest",
        kind: "test.event",
        status: "success",
        title: "Test Event 1",
      },
    ];

    it("returns 401 when missing Authorization header", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatchPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 202 when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatchPayload);

      expect(res.status).toBe(202);
    });
  });

  describe("GET /api/v1/telemetry/health", () => {
    it("returns 200 without authentication", async () => {
      const res = await request(app).get("/api/v1/telemetry/health");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});