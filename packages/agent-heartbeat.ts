/**
 * Agent Heartbeat Utility
 * VTID: DEV-CICDL-0031 Phase 2
 * 
 * Usage in any agent service:
 * 
 * import { startHeartbeat } from './heartbeat';
 * 
 * startHeartbeat({
 *   agentCrew: 'planner',
 *   agentRole: 'PLANNER',
 *   vtid: process.env.VTID || 'IDLE',
 *   gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:8080',
 *   intervalSeconds: 60
 * });
 */

export interface HeartbeatConfig {
  agentCrew: string;        // 'planner', 'worker', 'validator'
  agentRole: string;        // 'PLANNER', 'WORKER', 'VALIDATOR'
  vtid?: string;            // Current VTID being processed (or 'IDLE')
  gatewayUrl: string;       // Gateway base URL
  intervalSeconds?: number; // Default: 60
}

let heartbeatInterval: NodeJS.Timeout | null = null;
let lastVTID: string = "IDLE";

/**
 * Start sending heartbeats to OASIS via Gateway
 */
export function startHeartbeat(config: HeartbeatConfig): void {
  const interval = (config.intervalSeconds || 60) * 1000;
  
  // Clear existing interval if any
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  
  console.log(`❤️ Starting heartbeat for ${config.agentCrew} (${config.agentRole}) every ${config.intervalSeconds || 60}s`);
  
  // Send initial heartbeat immediately
  sendHeartbeat(config);
  
  // Set up recurring heartbeat
  heartbeatInterval = setInterval(() => {
    sendHeartbeat(config);
  }, interval);
}

/**
 * Update the VTID being processed (call this when agent picks up a new task)
 */
export function updateVTID(vtid: string): void {
  lastVTID = vtid || "IDLE";
  console.log(`🔄 Agent VTID updated: ${lastVTID}`);
}

/**
 * Stop sending heartbeats (call on shutdown)
 */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log("💔 Heartbeat stopped");
  }
}

/**
 * Send a single heartbeat to Gateway
 */
async function sendHeartbeat(config: HeartbeatConfig): Promise<void> {
  const currentVTID = config.vtid || lastVTID;
  
  // Don't spam when idle - coalesce to one per minute
  if (currentVTID === "IDLE" && Date.now() % 60000 > 5000) {
    return;
  }
  
  const payload = {
    service: config.agentCrew,
    event: "heartbeat",
    tenant: "vitana",
    status: "info" as const,
    notes: `${config.agentRole} agent heartbeat`,
    metadata: {
      agent_crew: config.agentCrew,
      agent_role: config.agentRole,
      vtid: currentVTID,
      timestamp: new Date().toISOString(),
    },
  };
  
  try {
    const response = await fetch(`${config.gatewayUrl}/events/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      console.error(`❌ Heartbeat failed: ${response.status}`);
    } else {
      console.log(`❤️ Heartbeat sent: ${config.agentRole} (${currentVTID})`);
    }
  } catch (error: any) {
    console.error(`❌ Heartbeat error: ${error.message}`);
  }
}

/**
 * Example usage in an agent service:
 * 
 * // In main.ts or index.ts
 * import { startHeartbeat, updateVTID, stopHeartbeat } from './heartbeat';
 * 
 * // Start heartbeat on service startup
 * startHeartbeat({
 *   agentCrew: 'planner',
 *   agentRole: 'PLANNER',
 *   gatewayUrl: process.env.GATEWAY_URL || 'https://vitana-gateway-86804897789.us-central1.run.app',
 *   intervalSeconds: 60
 * });
 * 
 * // When picking up a task
 * updateVTID('DEV-CICDL-0031');
 * 
 * // When task completes
 * updateVTID('IDLE');
 * 
 * // On shutdown
 * process.on('SIGTERM', () => {
 *   stopHeartbeat();
 *   process.exit(0);
 * });
 */
