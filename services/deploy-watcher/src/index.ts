/**
 * GCP Deploy Watcher
 * VTID: DEV-CICDL-0031 Phase 2
 * 
 * Monitors Cloud Run deployments and publishes events to OASIS
 * 
 * Can be run as:
 * 1. Cloud Run service with /poll endpoint (called by Cloud Scheduler)
 * 2. Standalone script run periodically
 * 3. Cloud Function triggered by Pub/Sub
 */

import express, { Request, Response } from "express";

const app = express();
const PORT = process.env.PORT || 8081;

interface DeployEvent {
  service: string;
  revision: string;
  region: string;
  status: "success" | "failure";
  vtid: string;
  timestamp: string;
  link: string;
}

/**
 * Query Cloud Logging for recent Cloud Run deployments
 */
async function fetchRecentDeploys(projectId: string, since: Date): Promise<DeployEvent[]> {
  // This would use @google-cloud/logging client in production
  // For now, returning mock structure
  
  const filter = `
    resource.type="cloud_run_revision"
    protoPayload.methodName="google.cloud.run.v2.Revisions.CreateRevision"
    timestamp >= "${since.toISOString()}"
  `;
  
  console.log(`🔍 Querying Cloud Logging: ${filter}`);
  
  // Mock implementation - in production, use:
  // const logging = new Logging({ projectId });
  // const [entries] = await logging.getEntries({ filter, pageSize: 100 });
  
  return [];
}

/**
 * Extract VTID from Cloud Run service labels or env vars
 */
function extractVTIDFromLabels(labels: Record<string, string> = {}): string {
  return labels.vtid || labels.vt_vtid || "UNSET";
}

/**
 * Publish deploy event to OASIS
 */
async function publishDeployEvent(event: DeployEvent): Promise<void> {
  const gatewayUrl = process.env.GATEWAY_URL || "http://localhost:8080";
  
  const payload = {
    service: "gcp",
    event: "deploy",
    tenant: "vitana",
    status: event.status,
    notes: `Cloud Run deployment: ${event.service} revision ${event.revision}`,
    metadata: {
      service_name: event.service,
      revision: event.revision,
      region: event.region,
      vtid: event.vtid,
      link: event.link,
      source: "gcp.deploy",
    },
  };
  
  try {
    const response = await fetch(`${gatewayUrl}/events/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      console.error(`❌ Failed to publish deploy event: ${response.status}`);
    } else {
      console.log(`✅ Deploy event published: ${event.service} (${event.vtid})`);
    }
  } catch (error: any) {
    console.error(`❌ Error publishing deploy event: ${error.message}`);
  }
}

/**
 * Poll for new deploys and publish to OASIS
 */
async function pollDeploys(): Promise<{ processed: number }> {
  const projectId = process.env.GCP_PROJECT || "lovable-vitana-vers1";
  const lookbackMinutes = 5; // Only look at last 5 minutes
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
  
  console.log(`📊 Polling for deploys since ${since.toISOString()}`);
  
  try {
    const deploys = await fetchRecentDeploys(projectId, since);
    
    for (const deploy of deploys) {
      await publishDeployEvent(deploy);
    }
    
    return { processed: deploys.length };
  } catch (error: any) {
    console.error(`❌ Error polling deploys: ${error.message}`);
    return { processed: 0 };
  }
}

// HTTP endpoint for Cloud Scheduler to trigger
app.post("/poll", async (_req: Request, res: Response) => {
  console.log("🔔 Deploy polling triggered");
  
  try {
    const result = await pollDeploys();
    res.status(200).json({
      ok: true,
      processed: result.processed,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error(`❌ Poll failed: ${error.message}`);
    res.status(500).json({
      error: "Poll failed",
      detail: error.message,
    });
  }
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: "deploy-watcher",
    timestamp: new Date().toISOString(),
  });
});

// Root endpoint
app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    service: "deploy-watcher",
    version: "1.0.0",
    endpoints: {
      poll: "POST /poll",
      health: "GET /health",
    },
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Deploy Watcher listening on port ${PORT}`);
    console.log(`📊 Endpoint: POST /poll`);
    console.log(`💚 Health: GET /health`);
  });
}

export default app;
