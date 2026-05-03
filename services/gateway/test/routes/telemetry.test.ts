import request from "supertest";
import express from "express";
import { router as telemetryRouter } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock dependencies
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
app.use("/api/v1/telemetry", telemetryRouter);

describe("Telemetry Routes", () => {
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
    
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as any)
    );
  });

  describe("GET /api/v1/telemetry/health", () => {
    it("should return 200 without auth", async () => {
      const response = await request(app).get("/api/v1/telemetry/health");
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validEvent = {
      vtid: "VTID-1234",
      layer: "core",
      module: "auth",
      source: "gateway",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    };

    it("should return 401 if no Authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should process event if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-1" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEvent);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatch = [
      {
        vtid: "VTID-1234",
        layer: "core",
        module: "auth",
        source: "gateway",
        kind: "test.event",
        status: "success",
        title: "Test Event",
      }
    ];

    it("should return 401 if no Authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatch);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should process batch if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-1" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatch);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});