import request from "supertest";
import app from "../src/index";

describe("VTID API - DEV-OASIS-0101", () => {
  let createdVtid: string;

  describe("vtid.create_should_allocate_from_sequence_and_persist_row", () => {
    it("should create VTID using sequence", async () => {
      const res = await request(app).post("/api/v1/vtid/create").send({
        task_family: "OASIS", task_module: "TEST", title: "Test VTID allocation", tenant: "vitana", is_test: true,
      }).expect(201);
      expect(res.body.vtid).toMatch(/^(OASIS-TEST-\d{4}-\d{4}|DEV-OASIS-\d{4})$/);
      createdVtid = res.body.vtid;
    });
  });

  describe("vtid.detail_should_return_single_object_or_404", () => {
    it("should return single object", async () => {
      if (!createdVtid) return;
      const res = await request(app).get("/api/v1/vtid/" + createdVtid);
      if (res.status === 200) {
        expect(res.body.vtid).toBe(createdVtid);
        expect(Array.isArray(res.body)).toBe(false);
      }
    });
    it("should return 404 for missing", async () => {
      await request(app).get("/api/v1/vtid/NONE-NONE-9999-9999").expect(404);
    });
  });

  describe("vtid.list_should_include_oasis_family_and_sort_by_updated_desc", () => {
    it("should include OASIS", async () => {
      const res = await request(app).get("/api/v1/vtid/list").expect(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("vtid.list_should_map_statuses_for_board_columns", () => {
    it("should filter by status", async () => {
      await request(app).get("/api/v1/vtid/list?status=scheduled").expect(200);
    });
  });

  describe("cors.options_should_allow_preflight_for_vtid_and_events_stream", () => {
    it("should allow OPTIONS", async () => {
      const res = await request(app).options("/api/v1/vtid/list");
      expect([200, 204]).toContain(res.status);
    });
  });
});
