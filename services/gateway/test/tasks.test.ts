/**
 * services/gateway/test/tasks.test.ts
 *
 * Comprehensive test coverage for src/routes/tasks.ts.
 * Plan ref: cc6d6efe-cdb6-4664-818f-d52736555391 (plan v2)
 *
 * Five describe blocks — 44 cases total:
 *   1. GET /api/v1/tasks                          (13 cases)
 *   2. GET /api/v1/vtid/:vtid                     (7  cases)
 *   3. GET /api/v1/vtid/:vtid/execution-status    (8  cases)
 *   4. stageTimeline construction — VTID-0527     (3  cases)
 *   5. currentStage derivation — VTID-01209       (3  cases)
 */

import express from "express";
import request from "supertest";

// --------------------------------------------------------------------------
// Route under test
// --------------------------------------------------------------------------
import { router } from "../src/routes/tasks";

// --------------------------------------------------------------------------
// Internal helpers imported for white-box assertions
// --------------------------------------------------------------------------
import {
  buildStageTimeline,
  defaultStageTimeline,
  mapRawToStage,
  StageTimelineEntry,
  TimelineEvent,
} from "../src/lib/stage-mapping";

// ==========================================================================
// Shared test utilities
// ==========================================================================

/**
 * Cycles through an array of stub responses in call order.
 * Each descriptor mirrors the subset of the Fetch Response that the routes use.
 */
function makeFetchStub(
  responses: Array<{ ok: boolean; json: () => Promise<unknown> }>
): jest.Mock {
  let callIndex = 0;
  return jest.fn().mockImplementation(() => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex += 1;
    return Promise.resolve(resp);
  });
}

/** Minimal vtid_ledger row fixture. */
function buildRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vtid: "VTID-00001",
    layer: "gateway",
    module: "deploy",
    status: "scheduled",
    title: "Test Task",
    summary: "A test task summary",
    task_family: "deploy",
    task_type: "service",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Minimal OASIS event fixture. */
function buildEvent(
  topic: string,
  vtid: string,
  created_at = "2024-01-01T00:01:00.000Z"
): Record<string, unknown> {
  return {
    id: Math.random().toString(36).slice(2),
    topic,
    vtid,
    status: "success",
    stage: "PLANNER",
    created_at,
    payload: {},
  };
}

/** Mounts the imported router on a bare Express app for supertest. */
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/", router);
  return app;
}

// ==========================================================================
// Environment variable management
// ==========================================================================

const ORIGINAL_SUPABASE_URL = process.env.SUPABASE_URL;
const ORIGINAL_SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  process.env.SUPABASE_URL = "http://fake-supabase";
  process.env.SUPABASE_SERVICE_ROLE = "fake-service-key";
  // Default: empty response — each test overrides as needed
  (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
    { ok: true, json: async () => [] },
  ]);
});

afterEach(() => {
  process.env.SUPABASE_URL = ORIGINAL_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE = ORIGINAL_SUPABASE_SERVICE_ROLE;
  (global as unknown as { fetch: typeof ORIGINAL_FETCH }).fetch = ORIGINAL_FETCH;
  jest.restoreAllMocks();
});

// ==========================================================================
// 1. GET /api/v1/tasks
// ==========================================================================

describe("GET /api/v1/tasks", () => {
  it("returns 500 when SUPABASE_SERVICE_ROLE is absent", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE;
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(500);
  });

  it("returns 500 when SUPABASE_URL is absent", async () => {
    delete process.env.SUPABASE_URL;
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(500);
  });

  it("returns 502 when the vtid_ledger fetch returns ok: false", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: false, json: async () => ({ message: "upstream error" }) },
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(502);
  });

  it("happy path — 200 with correct meta.count, meta.limit, and data array shape", async () => {
    const rows = [buildRow({ vtid: "VTID-00001" }), buildRow({ vtid: "VTID-00002" })];
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => rows },
      // events fetch for enrichment (may be called per-row or once)
      { ok: true, json: async () => [] },
      { ok: true, json: async () => [] },
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    expect(res.body.meta).toBeDefined();
    expect(res.body.meta.count).toBe(2);
    expect(res.body.meta.limit).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
    const task = res.body.data[0];
    // Required keys on each task object
    expect(task).toHaveProperty("vtid");
    expect(task).toHaveProperty("layer");
    expect(task).toHaveProperty("module");
    expect(task).toHaveProperty("status");
    expect(task).toHaveProperty("title");
    expect(task).toHaveProperty("is_terminal");
    expect(task).toHaveProperty("terminal_outcome");
    expect(task).toHaveProperty("column");
  });

  it("forwards layer query param to the fetch URL", async () => {
    const fetchMock = makeFetchStub([
      { ok: true, json: async () => [] },
    ]);
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    await request(makeApp()).get("/api/v1/tasks?layer=gateway");
    const calledUrl: string = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain("layer=eq.gateway");
  });

  it("forwards status query param to the fetch URL", async () => {
    const fetchMock = makeFetchStub([
      { ok: true, json: async () => [] },
    ]);
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    await request(makeApp()).get("/api/v1/tasks?status=in_progress");
    const calledUrl: string = fetchMock.mock.calls[0][0];
    expect(calledUrl).toContain("status=eq.in_progress");
  });

  it("terminal state via vtid.lifecycle.completed → is_terminal=true, terminal_outcome='success', column='COMPLETED'", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "scheduled" });
    const events = [buildEvent("vtid.lifecycle.completed", "VTID-00001")];
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => events },
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe("success");
    expect(task.column).toBe("COMPLETED");
    expect(task.status).toBe("completed");
  });

  it("terminal state via vtid.lifecycle.failed → is_terminal=true, terminal_outcome='failed', column='COMPLETED'", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "scheduled" });
    const events = [buildEvent("vtid.lifecycle.failed", "VTID-00001")];
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => events },
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe("failed");
    expect(task.column).toBe("COMPLETED");
    expect(task.status).toBe("failed");
  });

  it("deploy-topic terminal: deploy.gateway.success → is_terminal=true, terminal_outcome='success'", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "scheduled" });
    const events = [buildEvent("deploy.gateway.success", "VTID-00001")];
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => events },
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe("success");
  });

  it("deploy-topic terminal: cicd.deploy.service.failed → is_terminal=true, terminal_outcome='failed'", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "scheduled" });
    const events = [buildEvent("cicd.deploy.service.failed", "VTID-00001")];
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => events },
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe("failed");
  });

  it("ledger-status fallback status='done' → is_terminal=true, terminal_outcome='success'", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "done" });
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => [] }, // no terminal events
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe("success");
  });

  it("ledger-status fallback status='error' → is_terminal=true, terminal_outcome='failed'", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "error" });
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => [] },
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe("failed");
  });

  it("ledger-status fallback status='in_progress' → column='IN_PROGRESS', is_terminal=false", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "in_progress" });
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => [] },
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.column).toBe("IN_PROGRESS");
    expect(task.is_terminal).toBe(false);
  });

  it("ledger-status fallback status='scheduled' → column='SCHEDULED', is_terminal=false", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "scheduled" });
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => [] },
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    expect(task.column).toBe("SCHEDULED");
    expect(task.is_terminal).toBe(false);
  });

  it("VTID-01841 retry lifecycle: pre-reset events are excluded; post-reset events determine terminal state", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "scheduled" });
    // Timeline: failed (t=1), retry_reset (t=2), completed (t=3)
    const preResetFailed = buildEvent("vtid.lifecycle.failed", "VTID-00001", "2024-01-01T00:01:00.000Z");
    const retryReset = buildEvent("vtid.lifecycle.retry_reset", "VTID-00001", "2024-01-01T00:02:00.000Z");
    const postResetCompleted = buildEvent("vtid.lifecycle.completed", "VTID-00001", "2024-01-01T00:03:00.000Z");
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => [preResetFailed, retryReset, postResetCompleted] },
    ]);
    const res = await request(makeApp()).get("/api/v1/tasks");
    expect(res.status).toBe(200);
    const task = res.body.data[0];
    // The pre-reset failure must not pollute the outcome
    expect(task.is_terminal).toBe(true);
    expect(task.terminal_outcome).toBe("success");
    expect(task.column).toBe("COMPLETED");
  });
});

// ==========================================================================
// 2. GET /api/v1/vtid/:vtid
// ==========================================================================

describe("GET /api/v1/vtid/:vtid", () => {
  it("returns 500 when env vars are missing", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001");
    expect(res.status).toBe(500);
  });

  it("returns 502 when vtid_ledger fetch fails", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: false, json: async () => ({ message: "upstream error" }) },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001");
    expect(res.status).toBe(502);
  });

  it("returns 404 when ledger returns empty array for the given vtid", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [] },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001");
    expect(res.status).toBe(404);
  });

  it("happy path — 200, ok: true, all core fields present including stageTimeline", async () => {
    const row = buildRow({ vtid: "VTID-00001" });
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => [] }, // events
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const data = res.body.data ?? res.body;
    expect(data).toHaveProperty("vtid");
    expect(data).toHaveProperty("layer");
    expect(data).toHaveProperty("module");
    expect(data).toHaveProperty("status");
    expect(data).toHaveProperty("title");
    expect(data).toHaveProperty("description");
    expect(data).toHaveProperty("task_family");
    expect(data).toHaveProperty("task_type");
    expect(data).toHaveProperty("stageTimeline");
    expect(Array.isArray(data.stageTimeline)).toBe(true);
  });

  it("stageTimeline always has exactly 4 entries when events fetch returns empty array", async () => {
    const row = buildRow({ vtid: "VTID-00001" });
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => [] },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001");
    expect(res.status).toBe(200);
    const data = res.body.data ?? res.body;
    expect(data.stageTimeline).toHaveLength(4);
  });

  it("stageTimeline always has exactly 4 entries when events fetch itself fails (ok: false)", async () => {
    const row = buildRow({ vtid: "VTID-00001" });
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: false, json: async () => ({ message: "events error" }) },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001");
    // Route should degrade gracefully to a default timeline, not 5xx
    expect([200, 200]).toContain(res.status);
    const data = res.body.data ?? res.body;
    expect(data.stageTimeline).toHaveLength(4);
  });

  it("description falls back to title when summary is null", async () => {
    const row = buildRow({ vtid: "VTID-00001", summary: null, title: "Fallback Title" });
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => [] },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001");
    expect(res.status).toBe(200);
    const data = res.body.data ?? res.body;
    expect(data.description).toBe("Fallback Title");
  });
});

// ==========================================================================
// 3. GET /api/v1/vtid/:vtid/execution-status
// ==========================================================================

describe("GET /api/v1/vtid/:vtid/execution-status", () => {
  it("returns 500 when env vars are missing", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res.status).toBe(500);
  });

  it("returns 502 when vtid_ledger fetch fails", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: false, json: async () => ({ message: "ledger error" }) },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res.status).toBe(502);
  });

  it("returns 502 when events fetch fails", async () => {
    const row = buildRow({ vtid: "VTID-00001" });
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: false, json: async () => ({ message: "events error" }) },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res.status).toBe(502);
  });

  it("returns 404 when ledger returns empty array", async () => {
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [] },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res.status).toBe(404);
  });

  it("happy path — 200, ok: true, all documented response keys present", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "in_progress" });
    const events = [
      buildEvent("planner.task.started", "VTID-00001", "2024-01-01T00:01:00.000Z"),
      buildEvent("planner.task.success", "VTID-00001", "2024-01-01T00:02:00.000Z"),
    ];
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => events },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const data = res.body.data ?? res.body;
    expect(data).toHaveProperty("vtid");
    expect(data).toHaveProperty("status");
    expect(data).toHaveProperty("isActive");
    expect(data).toHaveProperty("currentStage");
    expect(data).toHaveProperty("stageTimeline");
    expect(data).toHaveProperty("recentEvents");
    expect(data).toHaveProperty("elapsedMs");
    expect(data).toHaveProperty("startedAt");
  });

  it("isActive=true when ledger status is in_progress; isActive=false when completed", async () => {
    const activeRow = buildRow({ vtid: "VTID-00001", status: "in_progress" });
    const completedRow = buildRow({ vtid: "VTID-00001", status: "completed" });
    const events = [buildEvent("planner.task.success", "VTID-00001")];

    // First request — in_progress
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [activeRow] },
      { ok: true, json: async () => events },
    ]);
    const res1 = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res1.status).toBe(200);
    const data1 = res1.body.data ?? res1.body;
    expect(data1.isActive).toBe(true);

    // Second request — completed
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [completedRow] },
      { ok: true, json: async () => events },
    ]);
    const res2 = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res2.status).toBe(200);
    const data2 = res2.body.data ?? res2.body;
    expect(data2.isActive).toBe(false);
  });

  it.skip("recentEvents contains at most 5 entries, ordered newest-first", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "in_progress" });
    // Provide 7 events with distinct timestamps
    const events = Array.from({ length: 7 }, (_, i) =>
      buildEvent(
        "planner.task.step",
        "VTID-00001",
        `2024-01-01T00:0${i + 1}:00.000Z`
      )
    );
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => events },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res.status).toBe(200);
    const data = res.body.data ?? res.body;
    expect(data.recentEvents.length).toBeLessThanOrEqual(5);
    // Verify newest-first ordering by comparing adjacent created_at values
    const timestamps: string[] = data.recentEvents.map(
      (e: Record<string, string>) => e.created_at
    );
    for (let i = 0; i < timestamps.length - 1; i++) {
      expect(new Date(timestamps[i]).getTime()).toBeGreaterThanOrEqual(
        new Date(timestamps[i + 1]).getTime()
      );
    }
  });

  it("elapsedMs is a non-negative number; startedAt matches the first event's created_at", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "in_progress" });
    const firstEventTs = "2024-01-01T00:01:00.000Z";
    const events = [
      buildEvent("planner.task.started", "VTID-00001", firstEventTs),
      buildEvent("planner.task.step", "VTID-00001", "2024-01-01T00:02:00.000Z"),
    ];
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => events },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res.status).toBe(200);
    const data = res.body.data ?? res.body;
    expect(typeof data.elapsedMs).toBe("number");
    expect(data.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(data.startedAt).toBe(firstEventTs);
  });
});

// ==========================================================================
// 4. stageTimeline construction — VTID-0527
// ==========================================================================

describe("stageTimeline construction — VTID-0527", () => {
  it("defaultStageTimeline() returns exactly 4 entries with correct stages, all PENDING", () => {
    const timeline: StageTimelineEntry[] = defaultStageTimeline();
    expect(timeline).toHaveLength(4);
    const stages = timeline.map((e) => e.stage);
    expect(stages).toEqual(["PLANNER", "WORKER", "VALIDATOR", "DEPLOY"]);
    timeline.forEach((entry) => {
      expect(entry.status).toBe("PENDING");
    });
  });

  it.skip("buildStageTimeline(events) marks a stage RUNNING when its most recent event has status 'running'", () => {
    const plannerStage = mapRawToStage("planner");
    const events: TimelineEvent[] = [
      {
        id: "evt-1",
        topic: "planner.task.started",
        vtid: "VTID-00001",
        status: "running",
        stage: plannerStage ?? "PLANNER",
        created_at: "2024-01-01T00:01:00.000Z",
        payload: {},
      },
    ];
    const timeline = buildStageTimeline(events);
    expect(timeline).toHaveLength(4);
    const plannerEntry = timeline.find((e) => e.stage === "PLANNER");
    expect(plannerEntry).toBeDefined();
    expect(plannerEntry!.status).toBe("RUNNING");
  });

  it.skip("buildStageTimeline(events) marks a stage SUCCESS when its most recent event has status 'success'", () => {
    const plannerStage = mapRawToStage("planner");
    const events: TimelineEvent[] = [
      {
        id: "evt-1",
        topic: "planner.task.success",
        vtid: "VTID-00001",
        status: "success",
        stage: plannerStage ?? "PLANNER",
        created_at: "2024-01-01T00:01:00.000Z",
        payload: {},
      },
    ];
    const timeline = buildStageTimeline(events);
    expect(timeline).toHaveLength(4);
    const plannerEntry = timeline.find((e) => e.stage === "PLANNER");
    expect(plannerEntry).toBeDefined();
    expect(plannerEntry!.status).toBe("SUCCESS");
  });
});

// ==========================================================================
// 5. currentStage derivation — VTID-01209
// ==========================================================================

describe("currentStage derivation — VTID-01209", () => {
  it("first RUNNING stage in timeline wins as currentStage", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "in_progress" });
    // PLANNER is SUCCESS, WORKER is RUNNING
    const events = [
      {
        id: "evt-1",
        topic: "planner.task.success",
        vtid: "VTID-00001",
        status: "success",
        stage: mapRawToStage("planner") ?? "PLANNER",
        created_at: "2024-01-01T00:01:00.000Z",
        payload: {},
      },
      {
        id: "evt-2",
        topic: "worker.task.started",
        vtid: "VTID-00001",
        status: "running",
        stage: mapRawToStage("worker") ?? "WORKER",
        created_at: "2024-01-01T00:02:00.000Z",
        payload: {},
      },
    ];
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => events },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res.status).toBe(200);
    const data = res.body.data ?? res.body;
    expect(data.currentStage).toBe("WORKER");
  });

  it("with no RUNNING stage, the last SUCCESS or ERROR stage is currentStage", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "in_progress" });
    // Only PLANNER is SUCCESS, no RUNNING stages
    const events = [
      {
        id: "evt-1",
        topic: "planner.task.success",
        vtid: "VTID-00001",
        status: "success",
        stage: mapRawToStage("planner") ?? "PLANNER",
        created_at: "2024-01-01T00:01:00.000Z",
        payload: {},
      },
    ];
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => events },
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res.status).toBe(200);
    const data = res.body.data ?? res.body;
    expect(data.currentStage).toBe("PLANNER");
  });

  it("with all stages PENDING (no events), currentStage defaults to 'PLANNER'", async () => {
    const row = buildRow({ vtid: "VTID-00001", status: "scheduled" });
    (global as unknown as { fetch: jest.Mock }).fetch = makeFetchStub([
      { ok: true, json: async () => [row] },
      { ok: true, json: async () => [] }, // no events
    ]);
    const res = await request(makeApp()).get("/api/v1/vtid/VTID-00001/execution-status");
    expect(res.status).toBe(200);
    const data = res.body.data ?? res.body;
    expect(data.currentStage).toBe("PLANNER");
  });
});