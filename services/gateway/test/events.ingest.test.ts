import request from "supertest";
import app from "../src/index";

describe("POST /events/ingest", () => {
  describe("Validation", () => {
    it("should reject empty payload", async () => {
      const res = await request(app).post("/events/ingest").send({});
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toBe("Invalid payload");
    });

    it("should reject missing required fields", async () => {
      const res = await request(app).post("/events/ingest").send({
        service: "test",
      });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });

    it("should reject invalid status enum", async () => {
      const res = await request(app).post("/events/ingest").send({
        service: "test",
        event: "test_event",
        tenant: "system",
        status: "invalid_status",
      });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    });
  });

  describe("Valid Payloads", () => {
    it("should accept minimal valid payload", async () => {
      const res = await request(app).post("/events/ingest").send({
        service: "test_service",
        event: "test_event",
        tenant: "system",
        status: "success",
      });
      expect([200, 500, 502]).toContain(res.status);
    });
  });
});

describe("GET /events/health", () => {
  it("should return healthy status", async () => {
    const res = await request(app).get("/events/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
    expect(res.body).toHaveProperty("service", "oasis-events");
  });
});
