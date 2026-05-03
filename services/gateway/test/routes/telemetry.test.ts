import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock Supabase
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock SSE devhub to prevent requirement of other service routes during isolated test
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    process.env.SUPABASE_URL = "https://mock.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE = "mock-service-role";
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VTID-1234",
      layer: "test",
      module: "auth",
      source: "jest",
      kind: "test.event",
      status: "success",
      title: "Test Event"
    };

    it("should return 401 if missing authorization header", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if auth token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: null },
        error: { message: "Invalid token" }
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);
      
      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should process event if authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({})
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);
      
      expect(res.status).toBe(202);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatch = [{
      vtid: "VTID-1234",
      layer: "test",
      module: "auth",
      source: "jest",
      kind: "test.event",
      status: "success",
      title: "Test Event"
    }];

    it("should return 401 if missing authorization header", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatch);
      
      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should process batch if authenticated", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null
      });

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({})
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validBatch);
      
      expect(res.status).toBe(202);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});