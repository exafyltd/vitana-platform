import express from "express";
import request from "supertest";
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

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      })
    ) as jest.Mock;
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
  });

  describe("POST /api/v1/telemetry/event", () => {
    const validEvent = {
      vtid: "VTID-123",
      layer: "app",
      module: "test",
      source: "tester",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    };

    it("should return 401 if Authorization header is missing", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEvent);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
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
    const validEvents = [{
      vtid: "VTID-123",
      layer: "app",
      module: "test",
      source: "tester",
      kind: "test.event",
      status: "success",
      title: "Test Event",
    }];

    it("should return 401 if Authorization header is missing", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validEvents);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should return 401 if token is invalid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: { message: "Invalid token" },
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validEvents);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should proceed and return 202 if token is valid", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validEvents);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
      expect(response.body.count).toBe(1);
      expect(global.fetch).toHaveBeenCalled();
    });
  });
});