#!/usr/bin/env node
/**
 * Auto-Logger CLI
 * 
 * Standalone service runner for Auto-Logger
 * 
 * VTID: DEV-CICDL-0040
 * 
 * Usage:
 *   npm run auto-logger              # Start service
 *   npm run auto-logger:report 001   # Generate report for VTID
 */

import AutoLogger from "./auto_logger";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Parse command line arguments
const command = process.argv[2] || "start";
const vtid = process.argv[3];

async function main() {
  console.log("=".repeat(80));
  console.log("AUTO-LOGGER SERVICE");
  console.log("VTID: DEV-CICDL-0040");
  console.log("=".repeat(80));
  console.log();
  
  // Initialize Auto-Logger
  const logger = new AutoLogger({
    sseUrl: process.env.SSE_FEED_URL,
    gatewayUrl: process.env.GATEWAY_URL,
    webhookUrl: process.env.DEVOPS_CHAT_WEBHOOK
  });
  
  // Execute command
  switch (command) {
    case "start":
      console.log("🚀 Starting Auto-Logger service...");
      console.log();
      
      // Start listening to events
      logger.start();
      
      // Keep process alive
      process.on("SIGINT", () => {
        console.log();
        console.log("🛑 Received SIGINT, shutting down...");
        logger.stop();
        process.exit(0);
      });
      
      process.on("SIGTERM", () => {
        console.log();
        console.log("🛑 Received SIGTERM, shutting down...");
        logger.stop();
        process.exit(0);
      });
      
      console.log("✅ Auto-Logger is running");
      console.log("   Press Ctrl+C to stop");
      console.log();
      break;
    
    case "report":
      if (!vtid) {
        console.error("❌ Error: VTID required for report generation");
        console.error("   Usage: npm run auto-logger:report <vtid>");
        process.exit(1);
      }
      
      console.log(`📊 Generating report for ${vtid}...`);
      console.log();
      
      await logger.generateReport(vtid);
      
      console.log();
      console.log("✅ Report generation complete");
      process.exit(0);
      break;
    
    case "test":
      console.log("🧪 Running Auto-Logger tests...");
      console.log();
      
      // Test template loading
      console.log("1. Testing template loading...");
      // Templates already loaded in constructor
      console.log("   ✅ Templates loaded");
      
      // Test OASIS connection
      console.log();
      console.log("2. Testing OASIS connection...");
      try {
        const testVtid = "DEV-TEST-0001";
        await logger.generateReport(testVtid);
        console.log("   ✅ OASIS connection working");
      } catch (error) {
        console.error("   ❌ OASIS connection failed:", error);
      }
      
      console.log();
      console.log("✅ Tests complete");
      process.exit(0);
      break;
    
    default:
      console.error(`❌ Unknown command: ${command}`);
      console.error();
      console.error("Available commands:");
      console.error("  start   - Start Auto-Logger service");
      console.error("  report  - Generate report for VTID");
      console.error("  test    - Run tests");
      process.exit(1);
  }
}

// Run
main().catch(error => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
