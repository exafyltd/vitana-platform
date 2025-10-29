import request from "supertest";
import app from "../src/index";

describe("Telemetry API", () => {
  describe("POST /api/v1/telemetry/event", () => {
    it("should accept valid telemetry event", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send({
          ts: new Date().toISOString(),
          vtid: "DEV-CICDL-0034",
          layer: "CICDL",
          module: "GATEWAY",
          source: "test.suite",
          kind: "test.smoke",
          status: "info",
          title: "TEST-SMOKE-EVENT",
          ref: "vt/DEV-CICDL-0034-test",
          link: null,
        });

      expect(response.status).toBe(202);
      expect(response.body).toHaveProperty("ok", true);
      expect(response.body).toHaveProperty("id");
      expect(response.body).toHaveProperty("vtid", "DEV-CICDL-0034");
    });

    it("should reject invalid payload", async () => {
      const response = await request(app)
        .post("/api/v1/telemetry/event")
        .send({
          vtid: "DEV-CICDL-0034",
          // Missing required fields
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error", "Invalid payload");
    });
  });

  describe("GET /api/v1/health", () => {
    it("should return gateway health", async () => {
      const response = await request(app).get("/api/v1/health");

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("ok", true);
      expect(response.body).toHaveProperty("service", "vitana-gateway");
    });
  });

  describe("GET /api/v1/telemetry/health", () => {
    it("should return telemetry subsystem health", async () => {
      const response = await request(app).get("/api/v1/telemetry/health");

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("ok", true);
      expect(response.body).toHaveProperty("service", "telemetry");
    });
  });
});
