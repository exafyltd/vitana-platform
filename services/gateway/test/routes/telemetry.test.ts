import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock supabase
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Build the express app
const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry API Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VT-123",
      layer: "app",
      module: "auth",
      source: "client",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    };

    it("should return 401 if no Authorization header is present", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(res.body.detail).toBe("Missing or invalid Authorization header");
    });

    it("should return 401 if Authorization token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer bad-token")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(res.body.detail).toBe("Invalid session token");
    });

    it("should proceed and persist event if authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer good-token")
        .send(validPayload);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:8000/rest/v1/oasis_events",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatch = [
      {
        vtid: "VT-123",
        layer: "app",
        module: "auth",
        source: "client",
        kind: "test.event",
        status: "success",
        title: "Test Event 1",
      },
    ];

    it("should return 401 if no Authorization header is present", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatch);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should return 401 if Authorization token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer bad-token")
        .send(validBatch);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should proceed and persist batch if authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer good-token")
        .send(validBatch);
      
      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:8000/rest/v1/oasis_events",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  describe("GET /api/v1/telemetry/health", () => {
    it("should return 200 without authentication", async () => {
      const res = await request(app).get("/api/v1/telemetry/health");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});