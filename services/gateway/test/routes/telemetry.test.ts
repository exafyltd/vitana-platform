import request from "supertest";
import express from "express";
import { router } from "../../src/routes/telemetry";
import { supabase } from "../../src/lib/supabase";

// Mock the supabase client
jest.mock("../../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
    },
  },
}));

// Mock the devhub broadcast to avoid errors related to dynamic requires
jest.mock("../../src/routes/devhub", () => ({
  broadcastEvent: jest.fn(),
}), { virtual: true });

const app = express();
app.use(express.json());
app.use("/api/v1/telemetry", router);

describe("Telemetry Routes Auth Enforcement", () => {
  const validEvent = {
    vtid: "VTID-123",
    layer: "layer1",
    module: "mod1",
    source: "src1",
    kind: "test.event",
    status: "success",
    title: "Test Event",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock global fetch for actual supabase rest call inside route handler
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
      text: async () => "",
    });
    
    process.env.SUPABASE_URL = "http://localhost:8000";
    process.env.SUPABASE_SERVICE_ROLE = "test-service-role-key";
  });

  describe("POST /api/v1/telemetry/event", () => {
    it("returns 401 when no token is provided", async () => {
      const res = await request(app).post("/api/v1/telemetry/event").send(validEvent);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 401 when an invalid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ data: { user: null }, error: { message: "Invalid token" } });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer invalid-token")
        .send(validEvent);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(supabase.auth.getUser).toHaveBeenCalledWith("invalid-token");
    });

    it("returns 202 when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ data: { user: { id: "user-123" } }, error: null });

      const res = await request(app)
        .post("/api/v1/telemetry/event")
        .set("Authorization", "Bearer valid-token")
        .send(validEvent);

      expect(res.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
    });
  });

  describe("POST /api/v1/telemetry/batch", () => {
    it("returns 401 when no token is provided", async () => {
      const res = await request(app).post("/api/v1/telemetry/batch").send([validEvent]);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("returns 202 when a valid token is provided", async () => {
      (supabase.auth.getUser as jest.Mock).mockResolvedValue({ data: { user: { id: "user-123" } }, error: null });

      const res = await request(app)
        .post("/api/v1/telemetry/batch")
        .set("Authorization", "Bearer valid-token")
        .send([validEvent]);

      expect(res.status).toBe(202);
      expect(supabase.auth.getUser).toHaveBeenCalledWith("valid-token");
    });
  });
});