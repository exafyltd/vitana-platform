import request from "supertest";
import app from "../src/index";

describe("VTID Ledger API", () => {
  let createdVtid: string;

  describe("POST /vtid/create", () => {
    it("should create a new VTID with valid payload", async () => {
      const response = await request(app)
        .post("/api/v1/vtid/create")
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
      expect(response.body.vtid).toMatch(/^VTID-\d{4}-\d{4}$/);
      expect(response.body.data).toHaveProperty("vtid");
      expect(response.body.data.task_family).toBe("governance");
      expect(response.body.data.task_type).toBe("test");

      createdVtid = response.body.vtid;
    });

    it("should reject invalid payload", async () => {
      const response = await request(app)
        .post("/api/v1/vtid/create")
        .send({
          taskFamily: "",
          description: "Missing task type",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid payload");
    });

    it("should create VTID with default pending status", async () => {
      const response = await request(app)
        .post("/api/v1/vtid/create")
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

  describe("GET /vtid/:vtid", () => {
    it("should retrieve an existing VTID", async () => {
      if (!createdVtid) {
        // Create a VTID first if none exists
        const createResponse = await request(app)
          .post("/api/v1/vtid/create")
          .send({
            taskFamily: "test",
            taskType: "retrieval",
            description: "Test VTID retrieval",
            tenant: "system",
          });
        createdVtid = createResponse.body.vtid;
      }

      const response = await request(app).get(`/api/v1/vtid/${createdVtid}`);

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.data.vtid).toBe(createdVtid);
    });

    it("should return 404 for non-existent VTID", async () => {
      const response = await request(app).get("/api/v1/vtid/VTID-9999-9999");

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("VTID not found");
    });

    it("should return 400 for invalid VTID format", async () => {
      const response = await request(app).get("/api/v1/vtid/invalid-format");

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid VTID format");
    });
  });

  describe("PATCH /vtid/:vtid", () => {
    it("should update VTID status", async () => {
      if (!createdVtid) {
        const createResponse = await request(app)
          .post("/api/v1/vtid/create")
          .send({
            taskFamily: "test",
            taskType: "update",
            description: "Test VTID update",
            tenant: "system",
          });
        createdVtid = createResponse.body.vtid;
      }

      const response = await request(app)
        .patch(`/api/v1/vtid/${createdVtid}`)
        .send({
          status: "active",
          assignedTo: "claude-caeo",
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.vtid).toBe(createdVtid);
    });

    it("should update VTID metadata", async () => {
      if (!createdVtid) {
        const createResponse = await request(app)
          .post("/api/v1/vtid/create")
          .send({
            taskFamily: "test",
            taskType: "metadata",
            description: "Test metadata update",
            tenant: "system",
          });
        createdVtid = createResponse.body.vtid;
      }

      const response = await request(app)
        .patch(`/api/v1/vtid/${createdVtid}`)
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
      const response = await request(app)
        .patch(`/api/v1/vtid/${createdVtid}`)
        .send({
          status: "invalid-status",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid payload");
    });
  });

  describe("GET /vtid/list", () => {
    it("should list all VTIDs", async () => {
      const response = await request(app).get("/api/v1/vtid/list");

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.count).toBeGreaterThan(0);
      expect(Array.isArray(response.body.data)).toBe(true);
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

  describe("GET /vtid/health", () => {
    it("should return healthy status", async () => {
      const response = await request(app).get("/api/v1/vtid/health");

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe("vtid-ledger");
      expect(response.body.timestamp).toBeDefined();
    });
  });
});
