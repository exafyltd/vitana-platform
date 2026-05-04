import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock the Supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock devhub to prevent SSE errors during tests
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry API Auth Enforcement", () => {
  beforeAll(() => {
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-svc-key";
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VT-123",
      layer: "app",
      module: "test",
      source: "jest",
      kind: "test.event",
      status: "success",
      title: "Test Event"
    };

    it("should return 401 when no Authorization header is present", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("should return 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token")
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);
      
      expect(res.status).toBe(401);
    });

    it("should proceed (202) when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      // Mock global fetch for the OASIS persistence call
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({})
      } as Response);

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validPayload = [{
      vtid: "VT-123",
      layer: "app",
      module: "test",
      source: "jest",
      kind: "test.event",
      status: "success",
      title: "Test Event"
    }];

    it("should return 401 when no Authorization header is present", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validPayload);
        
      expect(res.status).toBe(401);
    });

    it("should return 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: new Error("Invalid token")
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);
        
      expect(res.status).toBe(401);
    });

    it("should proceed (202) when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      // Mock global fetch
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({})
      } as Response);

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
    });
  });
});