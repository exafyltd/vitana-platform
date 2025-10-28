import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { router as eventsRouter } from "./routes/events";
import { router as vtidRouter } from "./routes/vtid";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

app.use("/", eventsRouter);
app.use("/", vtidRouter);

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
    console.log(`💚 Health: GET /events/health, GET /vtid/health`);
  });
}

export default app;
