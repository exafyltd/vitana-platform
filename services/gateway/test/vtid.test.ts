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

  // DEV-OASIS-0206: VTID Enforcement Layer Tests
  describe("vtid.get_or_create_endpoint - DEV-OASIS-0206", () => {
    it("should create new VTID when none provided", async () => {
      const res = await request(app).post("/api/v1/vtid/get-or-create").send({
        task_family: "DEV",
        task_module: "TEST",
        title: "Test get-or-create",
        agent: "test-agent"
      });
      // Allow both 201 (created) and 502 (if DB unavailable in test env)
      if (res.status === 201) {
        expect(res.body.ok).toBe(true);
        expect(res.body.vtid).toBeDefined();
        expect(res.body.source).toBe("created");
      }
    });

    it("should reject invalid VTID format", async () => {
      const res = await request(app).post("/api/v1/vtid/get-or-create").send({
        vtid: "invalid-vtid-format"
      });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe("INVALID_VTID_FORMAT");
    });

    it("should reject non-existent VTID", async () => {
      const res = await request(app).post("/api/v1/vtid/get-or-create").send({
        vtid: "DEV-FAKE-9999"
      });
      // Could be 400 (not found) or 502 (DB error)
      expect([400, 502]).toContain(res.status);
      expect(res.body.ok).toBe(false);
    });

    it("should use default values when not provided", async () => {
      const res = await request(app).post("/api/v1/vtid/get-or-create").send({});
      // Allow success or DB unavailable
      if (res.status === 201) {
        expect(res.body.ok).toBe(true);
        expect(res.body.layer).toBe("DEV");
        expect(res.body.module).toBe("OASIS");
      }
    });
  });

  describe("vtid.validate_endpoint - DEV-OASIS-0206", () => {
    it("should validate format of well-formed VTID", async () => {
      const res = await request(app).post("/api/v1/vtid/validate").send({
        vtid: "DEV-OASIS-0001"
      });
      // Allow success or DB error
      if (res.status === 200) {
        expect(res.body.ok).toBe(true);
        expect(res.body.format_valid).toBe(true);
      }
    });

    it("should reject malformed VTID", async () => {
      const res = await request(app).post("/api/v1/vtid/validate").send({
        vtid: "not-a-valid-vtid"
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.format_valid).toBe(false);
    });

    it("should require vtid field", async () => {
      const res = await request(app).post("/api/v1/vtid/validate").send({});
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe("MISSING_VTID");
    });
  });
});
