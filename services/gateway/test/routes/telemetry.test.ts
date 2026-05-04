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

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes", () => {
  let OLD_ENV: NodeJS.ProcessEnv;

  beforeAll(() => {
    OLD_ENV = process.env;
  });

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-key";

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ([]),
      text: async () => "[]",
    }) as any;
  });

  afterAll(() => {
    process.env = OLD_ENV;
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

    it("should return 401 if no Authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should return 401 if an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should proceed and return 202 if a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
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

    it("should return 401 if no Authorization header is provided", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should return 401 if an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: null },
        error: new Error("Invalid token"),
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer invalid-token")
        .send(validPayload);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("Unauthorized");
    });

    it("should proceed and return 202 if a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValueOnce({
        data: { user: { id: "user-123" } },
        error: null,
      });

      const response = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send(validPayload);

      expect(response.status).toBe(202);
      expect(response.body.ok).toBe(true);
    });
  });

  describe("GET /api/v1/telemetry/health", () => {
    it("should return 200 without authentication", async () => {
      const response = await request(app).get("/api/v1/telemetry/health");
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });

  describe("GET /api/v1/telemetry/snapshot", () => {
    it("should return 200 without authentication", async () => {
      const response = await request(app).get("/api/v1/telemetry/snapshot");
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });
});