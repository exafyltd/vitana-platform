import { Router, Request, Response } from "express";
import { z } from "zod";

export const router = Router();

const PingSchema = z.object({
  vtid: z.string().regex(/^VTID-\d{4}-\d{4,}$/, "Invalid VTID format"),
  message: z.string().optional(),
});

const WorkflowSchema = z.object({
  vtid: z.string().regex(/^VTID-\d{4}-\d{4,}$/, "Invalid VTID format"),
  action: z.string().min(1, "Action required"),
  params: z.record(z.any()),
});

router.post("/execute/ping", async (req: Request, res: Response) => {
  try {
    const body = PingSchema.parse(req.body);
    const now = new Date().toISOString();

    console.log(`🏓 Execute ping: ${body.vtid} - ${body.message || "PING"}`);

    return res.status(200).json({
      ok: true,
      when: now,
      echo: body.message || "PING",
      vtid: body.vtid,
      bridge: "execution-bridge-v1",
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payload",
        detail: e.errors,
      });
    }

    console.error("❌ Execute ping error:", e);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      detail: e.message,
    });
  }
});

router.post("/execute/workflow", async (req: Request, res: Response) => {
  try {
    const body = WorkflowSchema.parse(req.body);

    if (!body.action.includes(".")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid action format",
        detail: "Action must be in format: namespace.operation (e.g., deploy.service)",
      });
    }

    const execution_id = `ex_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    console.log(`🚀 Workflow execution requested: ${execution_id}`);
    console.log(`   VTID: ${body.vtid}`);
    console.log(`   Action: ${body.action}`);
    console.log(`   Params:`, JSON.stringify(body.params));

    return res.status(200).json({
      ok: true,
      execution_id,
      vtid: body.vtid,
      action: body.action,
      status: "validated",
      message: "Workflow validated - execution stub only (no actual execution)",
      timestamp: new Date().toISOString(),
    });
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payload",
        detail: e.errors,
      });
    }

    console.error("❌ Execute workflow error:", e);
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      detail: e.message,
    });
  }
});

router.get("/execute/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "execution-bridge",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    models: {
      planner: "Claude 3.5 Sonnet",
      executor: "Gemini Pro 1.5",
      forbidden: ["Gemini Flash 1.5"],
    },
  });
});
