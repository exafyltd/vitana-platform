import { Router, Request, Response } from "express";
import crypto from "crypto";

export const router = Router();

// VTID regex pattern (case-insensitive): DEV-CICDL-0031 format
const VTID_PATTERN = /([A-Z]{3}-[A-Z]{5}-\d{4})/i;

// Helper: Extract VTID from various sources
function extractVTID(payload: any): string {
  // Priority 1: PR title
  if (payload.pull_request?.title) {
    const match = payload.pull_request.title.match(VTID_PATTERN);
    if (match) return match[1].toUpperCase();
  }
  
  // Priority 2: Branch name
  if (payload.pull_request?.head?.ref) {
    const match = payload.pull_request.head.ref.match(VTID_PATTERN);
    if (match) return match[1].toUpperCase();
  }
  
  // Priority 3: Commit message (first commit)
  if (payload.commits && payload.commits.length > 0) {
    const match = payload.commits[0].message.match(VTID_PATTERN);
    if (match) return match[1].toUpperCase();
  }
  
  // Priority 4: Workflow run name
  if (payload.workflow_run?.name) {
    const match = payload.workflow_run.name.match(VTID_PATTERN);
    if (match) return match[1].toUpperCase();
  }
  
  return "UNSET";
}

// Helper: Extract layer from VTID (e.g., DEV-CICDL-0031 -> CICDL)
function extractLayer(vtid: string): string {
  if (vtid === "UNSET") return "UNKNOWN";
  const parts = vtid.split("-");
  return parts[1] || "UNKNOWN";
}

// Helper: Verify GitHub webhook signature
function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  if (!signature) return false;
  
  const hmac = crypto.createHmac("sha256", secret);
  const digest = "sha256=" + hmac.update(payload).digest("hex");
  
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return false;
  }
}

// Helper: Map GitHub status to our status
function mapGitHubStatus(ghStatus: string): string {
  const statusMap: Record<string, string> = {
    queued: "queued",
    in_progress: "in_progress",
    completed: "success",
    success: "success",
    failure: "failure",
    cancelled: "cancelled",
    skipped: "info",
    neutral: "info",
    action_required: "warning",
  };
  return statusMap[ghStatus] || "info";
}

// Helper: Create title from event
function createTitle(event: string, action: string, payload: any): string {
  const vtid = extractVTID(payload);
  const layer = extractLayer(vtid);
  
  let module = "GITHUB";
  let actionPart = action.toUpperCase().replace(/_/g, "-");
  
  if (event === "workflow_run") {
    module = "WORKFLOW";
    actionPart = payload.workflow_run?.conclusion?.toUpperCase() || "RUN";
  } else if (event === "check_run") {
    module = "CHECK";
    actionPart = payload.check_run?.conclusion?.toUpperCase() || "RUN";
  } else if (event === "pull_request") {
    module = "PR";
  } else if (event === "push") {
    module = "PUSH";
  }
  
  return `${layer}-${module}-${actionPart}`;
}

// Helper: Persist event to OASIS
async function persistToOASIS(eventData: {
  vtid: string;
  layer: string;
  module: string;
  source: string;
  kind: string;
  status: string;
  title: string;
  ref: string;
  link: string;
  meta: any;
}) {
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseUrl = process.env.SUPABASE_URL;
  
  if (!svcKey || !supabaseUrl) {
    throw new Error("Missing Supabase credentials");
  }
  
  const payload = {
    vtid: eventData.vtid,
    topic: eventData.kind,
    service: eventData.module.toLowerCase(),
    role: "SYSTEM",
    model: "github-webhook",
    status: eventData.status,
    message: eventData.title,
    link: eventData.link,
    metadata: eventData.meta,
  };
  
  const resp = await fetch(`${supabaseUrl}/rest/v1/oasis_events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: svcKey,
      Authorization: `Bearer ${svcKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });
  
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OASIS persist failed: ${resp.status} - ${text}`);
  }
  
  return await resp.json();
}

// GitHub webhook endpoint
router.post("/webhooks/github", async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    // Verify signature
    const signature = req.headers["x-hub-signature-256"] as string;
    const event = req.headers["x-github-event"] as string;
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    
    if (!secret) {
      console.error("❌ GITHUB_WEBHOOK_SECRET not configured");
      return res.status(500).json({ error: "Webhook not configured" });
    }
    
    const rawBody = JSON.stringify(req.body);
    
    if (!verifyGitHubSignature(rawBody, signature, secret)) {
      console.error("❌ GitHub webhook signature verification failed");
      return res.status(401).json({ error: "Invalid signature" });
    }
    
    console.log(`📥 GitHub webhook: ${event} (${req.body.action || "n/a"})`);
    
    // Handle specific events
    const payload = req.body;
    let eventData: any = null;
    
    if (event === "workflow_run") {
      const wf = payload.workflow_run;
      eventData = {
        vtid: extractVTID(payload),
        layer: extractLayer(extractVTID(payload)),
        module: "WORKFLOW",
        source: "github.actions",
        kind: "workflow_run",
        status: mapGitHubStatus(wf.conclusion || wf.status),
        title: createTitle(event, payload.action, payload),
        ref: wf.head_branch,
        link: wf.html_url,
        meta: {
          workflow_name: wf.name,
          workflow_id: wf.id,
          run_number: wf.run_number,
          event: wf.event,
          repository: payload.repository.full_name,
        },
      };
    } else if (event === "check_run") {
      const check = payload.check_run;
      eventData = {
        vtid: extractVTID(payload),
        layer: extractLayer(extractVTID(payload)),
        module: "CHECK",
        source: "github.actions",
        kind: "check_run",
        status: mapGitHubStatus(check.conclusion || check.status),
        title: createTitle(event, payload.action, payload),
        ref: check.check_suite?.head_branch || "unknown",
        link: check.html_url,
        meta: {
          check_name: check.name,
          check_id: check.id,
          repository: payload.repository.full_name,
        },
      };
    } else if (event === "pull_request") {
      const pr = payload.pull_request;
      eventData = {
        vtid: extractVTID(payload),
        layer: extractLayer(extractVTID(payload)),
        module: "PR",
        source: "github.actions",
        kind: "pull_request",
        status: payload.action === "closed" && pr.merged ? "success" : "info",
        title: createTitle(event, payload.action, payload),
        ref: pr.head.ref,
        link: pr.html_url,
        meta: {
          pr_number: pr.number,
          pr_title: pr.title,
          action: payload.action,
          merged: pr.merged,
          repository: payload.repository.full_name,
        },
      };
    } else if (event === "push") {
      eventData = {
        vtid: extractVTID(payload),
        layer: extractLayer(extractVTID(payload)),
        module: "PUSH",
        source: "github.actions",
        kind: "push",
        status: "info",
        title: createTitle(event, "commit", payload),
        ref: payload.ref,
        link: payload.compare,
        meta: {
          commits: payload.commits?.length || 0,
          repository: payload.repository.full_name,
          pusher: payload.pusher?.name,
        },
      };
    }
    
    if (eventData) {
      // Persist to OASIS
      await persistToOASIS(eventData);
      
      const elapsed = Date.now() - startTime;
      console.log(`✅ GitHub event persisted: ${eventData.vtid} - ${eventData.title} (${elapsed}ms)`);
      
      return res.status(200).json({
        ok: true,
        vtid: eventData.vtid,
        title: eventData.title,
        elapsed_ms: elapsed,
      });
    } else {
      // Unsupported event - acknowledge but don't process
      console.log(`⚠️ Unsupported GitHub event: ${event}`);
      return res.status(200).json({
        ok: true,
        message: `Event ${event} acknowledged but not processed`,
      });
    }
  } catch (error: any) {
    console.error("❌ GitHub webhook error:", error);
    
    // Log error to OASIS
    try {
      await persistToOASIS({
        vtid: "UNSET",
        layer: "CICDL",
        module: "WEBHOOK",
        source: "github.actions",
        kind: "error",
        status: "failure",
        title: "CICDL-WEBHOOK-ERROR",
        ref: "webhook-error",
        link: "",
        meta: { error: error.message },
      });
    } catch {}
    
    return res.status(500).json({
      error: "Webhook processing failed",
      detail: error.message,
    });
  }
});

// Health endpoint
router.get("/webhooks/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "github-webhook",
    timestamp: new Date().toISOString(),
  });
});
