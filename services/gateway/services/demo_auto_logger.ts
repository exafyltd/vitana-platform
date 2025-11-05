#!/usr/bin/env node
/**
 * Auto-Logger Demo - DEV-AICOR-0025
 * 
 * Demonstrates Auto-Logger functionality by generating a comprehensive
 * report for the KB Skills Integration task.
 * 
 * VTID: DEV-CICDL-0040
 */

import AutoLogger from "./auto_logger";
import dotenv from "dotenv";

dotenv.config();

const DEMO_VTID = "DEV-AICOR-0025";

async function runDemo() {
  console.log("=".repeat(80));
  console.log("AUTO-LOGGER DEMO");
  console.log("VTID: DEV-CICDL-0040");
  console.log("Demo Task: DEV-AICOR-0025 (KB Skills Integration)");
  console.log("=".repeat(80));
  console.log();
  
  // Initialize Auto-Logger
  console.log("📚 Initializing Auto-Logger...");
  const logger = new AutoLogger({
    sseUrl: process.env.SSE_FEED_URL || "http://localhost:8080/api/v1/devhub/feed",
    gatewayUrl: process.env.GATEWAY_URL || "http://localhost:8080",
    webhookUrl: process.env.DEVOPS_CHAT_WEBHOOK
  });
  console.log("✅ Auto-Logger initialized");
  console.log();
  
  // Generate comprehensive report for DEV-AICOR-0025
  console.log(`📊 Generating comprehensive report for ${DEMO_VTID}...`);
  console.log();
  
  await logger.generateReport(DEMO_VTID);
  
  console.log();
  console.log("=".repeat(80));
  console.log("✅ DEMO COMPLETE");
  console.log("=".repeat(80));
  console.log();
  console.log("Verification:");
  console.log("1. Check OASIS for vtid.update events:");
  console.log(`   curl http://localhost:8080/api/v1/oasis/events?vtid=${DEMO_VTID}&kind=vtid.update`);
  console.log();
  console.log("2. Check DevOps Chat for summary message");
  console.log();
  console.log("Expected Output:");
  console.log("  ✅ Phase B completion summary");
  console.log("  ✅ 12+ KB skill events tracked");
  console.log("  ✅ Performance metrics included");
  console.log("  ✅ Auto-generated status update");
  console.log();
  
  process.exit(0);
}

// Run demo
runDemo().catch(error => {
  console.error("❌ Demo failed:", error);
  process.exit(1);
});
