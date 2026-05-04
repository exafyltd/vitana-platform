import request from "supertest";
import express from "express";
import { router as telemetryRouter } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn()
    }
  }
}));

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", telemetryRouter);

describe("Telemetry Routes Auth Enforcement", () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-key";
    
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({})
    } as any);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("POST /api/v1/telemetry/event", () => {
    it("returns 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send({
          vtid: "VTID-123",
          layer: "app",
          module: "test",
          source: "jest",
          kind: "test.event",
          status: "info",
          title: "Test Event"
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("returns 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token")
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send({
          vtid: "VTID-123",
          layer: "app",
          module: "test",
          source: "jest",
          kind: "test.event",
          status: "info",
          title: "Test Event"
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("proceeds when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send({
          vtid: "VTID-123",
          layer: "app",
          module: "test",
          source: "jest",
          kind: "test.event",
          status: "info",
          title: "Test Event"
        });

      expect(response.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("returns 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([
          {
            vtid: "VTID-123",
            layer: "app",
            module: "test",
            source: "jest",
            kind: "test.event",
            status: "info",
            title: "Test Event"
          }
        ]);

      expect(response.status).toBe(401);
    });

    it("proceeds when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([
          {
            vtid: "VTID-123",
            layer: "app",
            module: "test",
            source: "jest",
            kind: "test.event",
            status: "info",
            title: "Test Event"
          }
        ]);

      expect(response.status).toBe(202);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});