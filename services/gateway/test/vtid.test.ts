import request from "supertest";
import app from "../src/index";

describe("VTID API - DEV-OASIS-0101", () => {
  let createdVtid: string;

  describe("vtid.create_should_allocate_from_sequence_and_persist_row", () => {
    it("should create VTID using sequence", async () => {
      const res = await request(app).post("/api/v1/vtid/create").send({
        task_family: "OASIS", task_module: "TEST", title: "Test VTID allocation", tenant: "vitana", is_test: true,
        target_roles: ["DEV"], // VTID-01010: Required field
      }).expect(201);
      expect(res.body.vtid).toMatch(/^(OASIS-TEST-\d{4}-\d{4}|DEV-OASIS-\d{4})$/);
      // VTID-01010: Verify target_roles in response
      expect(res.body.target_roles).toEqual(["DEV"]);
      createdVtid = res.body.vtid;
    });
  });

  describe("vtid.detail_should_return_single_object_or_404", () => {
    it("should return single object", async () => {
      if (!createdVtid) return;
      const res = await request(app).get("/api/v1/vtid/" + createdVtid);
      if (res.status === 200) {
        // VTID-0527-C: Response is now wrapped in { ok, data }
        expect(res.body.ok).toBe(true);
        expect(res.body.data.vtid).toBe(createdVtid);
        expect(Array.isArray(res.body.data)).toBe(false);
        // VTID-0527-C: stageTimeline should always be present with 4 entries
        expect(Array.isArray(res.body.data.stageTimeline)).toBe(true);
        expect(res.body.data.stageTimeline.length).toBe(4);
      }
    });
    it("should return 404 for missing", async () => {
      await request(app).get("/api/v1/vtid/NONE-NONE-9999-9999").expect(404);
    });
  });

  describe("vtid.list_should_include_oasis_family_and_sort_by_updated_desc", () => {
    it("should return ok=true and data array", async () => {
      const res = await request(app).get("/api/v1/vtid/list").expect(200);
      // VTID-0543: Response is now { ok: true, count: n, data: [...] }
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.count).toBe("number");
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe("vtid.list_should_map_statuses_for_board_columns", () => {
    it("should filter by status", async () => {
      const res = await request(app).get("/api/v1/vtid/list?status=scheduled").expect(200);
      // VTID-0543: Response is now { ok: true, count: n, data: [...] }
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // VTID-0543: Regression test for limit parameter
  describe("vtid.list_regression_limit_parameter", () => {
    it("should handle limit=5 and return ok=true with data array", async () => {
      const res = await request(app).get("/api/v1/vtid/list?limit=5").expect(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.count).toBe("number");
      expect(Array.isArray(res.body.data)).toBe(true);
      // Verify limit is respected (count <= 5)
      expect(res.body.data.length).toBeLessThanOrEqual(5);
    });

    it("should enforce max limit of 200", async () => {
      const res = await request(app).get("/api/v1/vtid/list?limit=500").expect(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      // Should be capped at 200
      expect(res.body.data.length).toBeLessThanOrEqual(200);
    });

    it("should handle invalid limit gracefully", async () => {
      const res = await request(app).get("/api/v1/vtid/list?limit=abc").expect(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe("cors.options_should_allow_preflight_for_vtid_and_events_stream", () => {
    it("should allow OPTIONS", async () => {
      const res = await request(app).options("/api/v1/vtid/list");
      expect([200, 204]).toContain(res.status);
    });
  });

  // VTID-0543: Regression test for atomic allocator
  // Ensures consecutive creates get incremented sequence numbers (no collisions)
  describe("vtid.allocator_atomic_increment_regression", () => {
    it("should increment sequence for consecutive creates (no 409 collision)", async () => {
      // Create first VTID
      const res1 = await request(app).post("/api/v1/vtid/create").send({
        task_family: "DEV",
        task_module: "REGTEST",
        title: "Allocator regression test 1",
        tenant: "vitana",
        is_test: true,
        target_roles: ["DEV"], // VTID-01010: Required field
      });
      expect([201, 200]).toContain(res1.status);
      expect(res1.body.ok).toBe(true);
      const vtid1 = res1.body.vtid;
      expect(vtid1).toBeDefined();

      // Create second VTID immediately (same family/module)
      const res2 = await request(app).post("/api/v1/vtid/create").send({
        task_family: "DEV",
        task_module: "REGTEST",
        title: "Allocator regression test 2",
        tenant: "vitana",
        is_test: true,
        target_roles: ["DEV"], // VTID-01010: Required field
      });
      // VTID-0543: Must NOT be 409 (duplicate key)
      expect(res2.status).not.toBe(409);
      expect([201, 200]).toContain(res2.status);
      expect(res2.body.ok).toBe(true);
      const vtid2 = res2.body.vtid;
      expect(vtid2).toBeDefined();

      // VTIDs must be different
      expect(vtid2).not.toBe(vtid1);

      // Extract sequence numbers from VTIDs
      // Format: DEV-REGTEST-2025-0001, DEV-REGTEST-2025-0002
      const seq1 = parseInt(vtid1.split("-").pop() || "0", 10);
      const seq2 = parseInt(vtid2.split("-").pop() || "0", 10);

      // Second sequence should be greater (not equal - that would cause 409)
      expect(seq2).toBeGreaterThan(seq1);
    });

    it("should handle concurrent creates without collision", async () => {
      // Fire off 3 concurrent creates
      const promises = [1, 2, 3].map((n) =>
        request(app).post("/api/v1/vtid/create").send({
          task_family: "DEV",
          task_module: "CONC",
          title: `Concurrent test ${n}`,
          tenant: "vitana",
          is_test: true,
          target_roles: ["DEV"], // VTID-01010: Required field
        })
      );

      const results = await Promise.all(promises);

      // All should succeed (no 409s)
      results.forEach((res, i) => {
        expect(res.status).not.toBe(409);
        expect([201, 200]).toContain(res.status);
        expect(res.body.ok).toBe(true);
      });

      // All VTIDs should be unique
      const vtids = results.map((r) => r.body.vtid);
      const uniqueVtids = new Set(vtids);
      expect(uniqueVtids.size).toBe(vtids.length);
    });
  });

  // VTID-01010: Target role validation tests
  describe("vtid.target_role_validation", () => {
    it("should reject create without target_roles", async () => {
      const res = await request(app).post("/api/v1/vtid/create").send({
        task_family: "DEV",
        task_module: "TEST",
        title: "Test without roles",
        tenant: "vitana",
        is_test: true,
      }).expect(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe("validation_failed");
    });

    it("should reject create with empty target_roles array", async () => {
      const res = await request(app).post("/api/v1/vtid/create").send({
        task_family: "DEV",
        task_module: "TEST",
        title: "Test with empty roles",
        tenant: "vitana",
        is_test: true,
        target_roles: [],
      }).expect(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe("validation_failed");
    });

    it("should reject create with invalid role", async () => {
      const res = await request(app).post("/api/v1/vtid/create").send({
        task_family: "DEV",
        task_module: "TEST",
        title: "Test with invalid role",
        tenant: "vitana",
        is_test: true,
        target_roles: ["INVALID"],
      }).expect(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe("validation_failed");
    });

    it("should reject INFRA combined with other roles", async () => {
      const res = await request(app).post("/api/v1/vtid/create").send({
        task_family: "DEV",
        task_module: "TEST",
        title: "Test INFRA with others",
        tenant: "vitana",
        is_test: true,
        target_roles: ["INFRA", "DEV"],
      }).expect(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.message).toContain("INFRA role is exclusive");
    });

    it("should accept INFRA alone", async () => {
      const res = await request(app).post("/api/v1/vtid/create").send({
        task_family: "DEV",
        task_module: "TEST",
        title: "Test INFRA alone",
        tenant: "vitana",
        is_test: true,
        target_roles: ["INFRA"],
      }).expect(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.target_roles).toEqual(["INFRA"]);
    });

    it("should accept multiple non-INFRA roles", async () => {
      const res = await request(app).post("/api/v1/vtid/create").send({
        task_family: "DEV",
        task_module: "TEST",
        title: "Test multiple roles",
        tenant: "vitana",
        is_test: true,
        target_roles: ["DEV", "ADM"],
      }).expect(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.target_roles).toEqual(["DEV", "ADM"]);
    });
  });
});
