import request from "supertest";
import app from "../src/index";

// Canonical VTID format: DEV-MODULE-NNNN (e.g., DEV-OASIS-0010)
const VTID_REGEX = /^DEV-[A-Z]{5}-\d{4}(\.\d+)?$/;

describe("VTID Ledger API", () => {
  let createdVtid: string;

  describe("POST /api/v1/vtid", () => {
    it("should create a new VTID with valid payload", async () => {
      const response = await request(app)
        .post("/api/v1/vtid")
        .send({
          taskFamily: "governance",
          taskType: "test",
          description: "Test VTID creation",
          status: "pending",
          tenant: "system",
          metadata: {
            testRun: true,
            automated: true,
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.vtid).toMatch(VTID_REGEX);
      expect(response.body.data).toHaveProperty("vtid");
      expect(response.body.data.task_family).toBe("governance");
      expect(response.body.data.task_type).toBe("test");

      createdVtid = response.body.vtid;
    });

    it("should reject invalid payload", async () => {
      const response = await request(app)
        .post("/api/v1/vtid")
        .send({
          taskFamily: "",
          description: "Missing task type",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid payload");
    });

    it("should create VTID with default pending status", async () => {
      const response = await request(app)
        .post("/api/v1/vtid")
        .send({
          taskFamily: "deployment",
          taskType: "migration",
          description: "Test default status",
          tenant: "system",
        });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe("pending");
    });
  });

  describe("GET /api/v1/vtid/:vtid", () => {
    it("should retrieve an existing VTID", async () => {
      // Always create fresh VTID for this test (mock resets between tests)
      const createResponse = await request(app)
        .post("/api/v1/vtid")
        .send({
          taskFamily: "test",
          taskType: "retrieval",
          description: "Test VTID retrieval",
          tenant: "system",
        });
      
      const vtidToRetrieve = createResponse.body.vtid;
      expect(vtidToRetrieve).toMatch(VTID_REGEX);

      const response = await request(app).get(`/api/v1/vtid/${vtidToRetrieve}`);

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data.vtid).toBe(vtidToRetrieve);
    });

    it("should return 404 for non-existent VTID", async () => {
      const response = await request(app).get("/api/v1/vtid/DEV-XXXXX-9999");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("VTID not found");
    });

    it("should return 400 for invalid VTID format", async () => {
      const response = await request(app).get("/api/v1/vtid/invalid-format");

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid VTID format");
    });
  });

  describe("PATCH /api/v1/vtid/:vtid", () => {
    it("should update VTID status", async () => {
      // Create fresh VTID for update test
      const createResponse = await request(app)
        .post("/api/v1/vtid")
        .send({
          taskFamily: "test",
          taskType: "update",
          description: "Test VTID update",
          tenant: "system",
        });
      const vtidToUpdate = createResponse.body.vtid;

      const response = await request(app)
        .patch(`/api/v1/vtid/${vtidToUpdate}`)
        .send({
          status: "active",
          assignedTo: "claude-caeo",
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.vtid).toBe(vtidToUpdate);
    });

    it("should update VTID metadata", async () => {
      // Create fresh VTID for metadata test
      const createResponse = await request(app)
        .post("/api/v1/vtid")
        .send({
          taskFamily: "test",
          taskType: "metadata",
          description: "Test metadata update",
          tenant: "system",
        });
      const vtidToUpdate = createResponse.body.vtid;

      const response = await request(app)
        .patch(`/api/v1/vtid/${vtidToUpdate}`)
        .send({
          metadata: {
            progress: 50,
            notes: "Halfway complete",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    it("should reject invalid status", async () => {
      // Create fresh VTID for invalid status test
      const createResponse = await request(app)
        .post("/api/v1/vtid")
        .send({
          taskFamily: "test",
          taskType: "invalid",
          description: "Test invalid status",
          tenant: "system",
        });
      const vtidToUpdate = createResponse.body.vtid;

      const response = await request(app)
        .patch(`/api/v1/vtid/${vtidToUpdate}`)
        .send({
          status: "invalid-status",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid payload");
    });
  });

  describe("GET /api/v1/vtid/list", () => {
    it("should list all VTIDs", async () => {
      const response = await request(app).get("/api/v1/vtid/list");

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(Array.isArray(response.body.data)).toBe(true);
      // Allow empty list in CI
      if (response.body.data.length > 0) {
        expect(response.body.data[0]).toHaveProperty("vtid");
        expect(response.body.data[0].vtid).toMatch(VTID_REGEX);
      }
    });

    it("should filter VTIDs by task family", async () => {
      const response = await request(app).get("/api/v1/vtid/list?taskFamily=governance");

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      if (response.body.count > 0) {
        response.body.data.forEach((vtid: any) => {
          expect(vtid.task_family).toBe("governance");
        });
      }
    });

    it("should filter VTIDs by status", async () => {
      const response = await request(app).get("/api/v1/vtid/list?status=pending");

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      if (response.body.count > 0) {
        response.body.data.forEach((vtid: any) => {
          expect(vtid.status).toBe("pending");
        });
      }
    });

    it("should respect limit parameter", async () => {
      const response = await request(app).get("/api/v1/vtid/list?limit=5");

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeLessThanOrEqual(5);
    });
  });

  describe("GET /api/v1/vtid/health", () => {
    it("should return healthy status", async () => {
      const response = await request(app).get("/api/v1/vtid/health");

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe("vtid-ledger");
      expect(response.body.timestamp).toBeDefined();
    });
  });
});
