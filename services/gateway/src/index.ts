import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { router as eventsRouter } from "./routes/events";
import { router as vtidRouter } from "./routes/vtid";
import auto-logger-health-route from "./routes/auto-logger-health-route";
import { router as executeRouter } from "./routes/execute";
import { router as devhubRouter } from "./routes/devhub";
import { router as webhooksRouter } from "./routes/webhooks";
import { router as telemetryRouter } from "./routes/telemetry";
import { router as contextRouter } from "./routes/context";
import command-hubRouter from "./routes/command-hub";
import { require-vtid, VTIDRequest } from "./middleware/require-vtid";
import { auto-logger-service } from "./services/auto-logger-service";
import { autoLoggerMetrics } from "./services/auto-logger-metrics";
import dotenv from "dotenv";

dotenv.config();

const app = express();
// Global Auto-Logger instance
let autoLoggerInstance: any = null;

export function getAutoLogger() {
  return autoLoggerInstance;
}

async function sendTelemetryToOasis(payload: any): Promise<void> {
  const url = (process.env.GATEWAY_URL || "http://localhost:8080") + "/events/ingest";
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!r.ok) console.error("[Telemetry] Failed:", r.status);
  } catch (e) { console.error("[Telemetry] Error:", e); }
}

const PORT = process.env.PORT || 8080;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

app.use("/context", contextRouter);
app.use("/", eventsRouter);
app.use("/", vtidRouter);
app.use("/", executeRouter);
app.use("/", devhubRouter);
app.use("/", webhooksRouter);
app.use("/health/auto-logger", auto-logger-health-route);
app.use("/", telemetryRouter);
app.use("/command-hub", command-hubRouter);

app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "vitana-gateway",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

app.post("/new-request-with-notification", (req: Request, res: Response) => {
  console.log("📬 Legacy notification received:", req.body);
  res.status(200).json({ ok: true, message: "Notification received" });
});

app.post("/act", require-vtid, (req: VTIDRequest, res: Response) => {
  const { op, params } = req.body;
  const vtid = (req as any).context?.vtid || (req as any).vtid;

  console.log(`🎬 Action requested: ${op} via ${vtid?.vtid}`);

  if (!op) {
    return res.status(400).json({
      error: "Operation required",
      detail: "Provide 'op' field in body",
    });
  }

  res.status(200).json({
    ok: true,
    message: `Operation '${op}' executed`,
    vtid: vtid?.vtid,
    taskFamily: vtid?.task_family,
    params: params || {},
    timestamp: new Date().toISOString(),
  });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    detail: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: "Not found",
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Gateway listening on port ${PORT}`);
    console.log(`📊 OASIS Events: POST /events/ingest`);
    console.log(`🔢 VTID Ledger: POST /vtid/create, GET /vtid/:vtid`);
    console.log(`⚡ Execution: POST /execute/ping, POST /execute/workflow`);
    console.log(`📡 DevHub Feed: GET /api/v1/devhub/feed (SSE)`);
    console.log(`📊 Telemetry: POST /api/v1/telemetry/event, POST /api/v1/telemetry/batch`);
    console.log(`🔗 Webhooks: POST /webhooks/github`);
    console.log(`💚 Health: GET /api/v1/health, GET /api/v1/telemetry/health`);
    
    // Start Auto-Logger
    if (process.env.ENABLE_AUTO_LOGGER === "true") {
      try {
        autoLoggerInstance = new auto-logger-service();
        console.log("✅ Auto-Logger initialized");
        autoLoggerMetrics.startTelemetryScheduler({ intervalMinutes: 60, emitEvent: sendTelemetryToOasis });
        console.log("✅ Telemetry started (60min)");
        // Note: processEvent() will be called from events route
      } catch (err) {
        console.error("❌ Auto-Logger initialization error:", err);
      }
    } else {
      console.log("⚠️  Auto-Logger disabled (ENABLE_AUTO_LOGGER not true)");
    }
  });
}

export default app;
