import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn()
    }
  }
}));

// Mock dynamic require inside the router
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn()
}), { virtual: true });

describe("Telemetry Routes Auth", () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use("/api/v1/telemetry", router);
    
    // Mock global fetch
    global.fetch = jest.fn();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-role-key";
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validPayload = {
      vtid: "VTID-123",
      layer: "layer1",
      module: "module1",
      source: "source1",
      kind: "kind1",
      status: "success",
      title: "title1"
    };

    it("should return 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid token" }
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer bad-token")
        .send(validPayload);
      
      expect(response.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("bad-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed (202) when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer good-token")
        .send(validPayload);
      
      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("good-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    const validBatch = [{
      vtid: "VTID-123",
      layer: "layer1",
      module: "module1",
      source: "source1",
      kind: "kind1",
      status: "success",
      title: "title1"
    }];

    it("should return 401 when no token is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validBatch);
      
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: "Unauthorized" });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid token" }
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer bad-token")
        .send(validBatch);
      
      expect(response.status).toBe(401);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("bad-token");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed (202) when token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer good-token")
        .send(validBatch);
      
      expect(response.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("good-token");
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});