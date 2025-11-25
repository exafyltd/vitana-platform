import request from "supertest";
import app from "../src/index";

describe("GET /api/v1/tasks", () => {
  it("returns 200 with default limit", async () => {
    const res = await request(app).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta.limit).toBe(100);
  });

  it("respects limit parameter", async () => {
    const res = await request(app).get("/api/v1/tasks?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta.limit).toBe(5);
  });
});
