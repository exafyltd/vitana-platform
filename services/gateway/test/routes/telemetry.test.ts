import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock devhub to prevent side effects during testing
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}));

// Mock supabase client to intercept and fake auth calls
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

describe("Telemetry Routes Auth Restrictions", () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // Mount router in exact path matching actual execution
    app.use("/api/v1/telemetry", router);

    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock global fetch returning ok by default for oasis_events insertions
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as any)
    );
  });

  const validEventPayload = {
    vtid: "VTID-1234",
    layer: "gateway",
    module: "telemetry",
    source: "test-source",
    kind: "test.kind",
    status: "success",
    title: "Test Event"
  };

  describe("POST /api/v1/telemetry/event", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("returns 401 when token is invalid or expired", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Token expired"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEventPayload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("returns 202 when authenticated and payload is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "test-user-id" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEventPayload);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .send([validEventPayload]);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("returns 401 when token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Bad token"),
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer bad-token")
        .send([validEventPayload]);

      expect(res.status).toBe(401);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("returns 202 when authenticated and payload is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "test-user-id" } },
        error: null,
      });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validEventPayload]);

      expect(res.status).toBe(202);
      expect(res.body.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});