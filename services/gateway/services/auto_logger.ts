/**
 * Auto-Logger Service
 * 
 * Automatically generates human-readable summaries from OASIS events
 * and posts them to OASIS + Command Hub (DevOps Chat).
 * 
 * VTID: DEV-CICDL-0040
 * 
 * Features:
 * - Subscribes to OASIS event stream
 * - Generates summaries using templates
 * - Posts to OASIS (vtid.update events)
 * - Posts to DevOps Chat webhook
 * - Batches similar events
 * - Handles priority events immediately
 */

import EventSource from "eventsource";
import yaml from "yaml";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// ============================================================================
// Types
// ============================================================================

interface TickerEvent {
  ts: string;
  vtid: string;
  layer: string;
  module: string;
  source: string;
  kind: string;
  status: string;
  title: string;
  ref: string;
  link: string | null;
  meta?: Record<string, any>;
}

interface MessageTemplate {
  title: string;
  message: string;
}

interface Templates {
  templates: Record<string, MessageTemplate>;
  milestones?: Record<string, MessageTemplate>;
  config: {
    batch_window: number;
    batch_threshold: number;
    excluded_events: string[];
    priority_events: string[];
    status_icons: Record<string, string>;
  };
}

interface EventBatch {
  vtid: string;
  events: TickerEvent[];
  firstSeen: Date;
}

// ============================================================================
// Auto-Logger Class
// ============================================================================

export class AutoLogger {
  private templates: Templates;
  private eventSource: EventSource | null = null;
  private eventBatches: Map<string, EventBatch> = new Map();
  private batchTimer: NodeJS.Timeout | null = null;
  
  private readonly sseUrl: string;
  private readonly gatewayUrl: string;
  private readonly webhookUrl: string | null;
  private readonly supabaseUrl: string;
  private readonly supabaseKey: string;
  
  constructor(config?: {
    sseUrl?: string;
    gatewayUrl?: string;
    webhookUrl?: string;
    templatesPath?: string;
  }) {
    // Load configuration from env or config
    this.sseUrl = config?.sseUrl || process.env.SSE_FEED_URL || "http://localhost:8080/api/v1/devhub/feed";
    this.gatewayUrl = config?.gatewayUrl || process.env.GATEWAY_URL || "http://localhost:8080";
    this.webhookUrl = config?.webhookUrl || process.env.DEVOPS_CHAT_WEBHOOK || null;
    this.supabaseUrl = process.env.SUPABASE_URL || "";
    this.supabaseKey = process.env.SUPABASE_SERVICE_ROLE || "";
    
    // Load templates
    const templatesPath = config?.templatesPath || 
      path.join(__dirname, "../config/auto_logger_templates.yaml");
    this.templates = this.loadTemplates(templatesPath);
    
    console.log("✅ Auto-Logger initialized");
    console.log(`   SSE Feed: ${this.sseUrl}`);
    console.log(`   Gateway: ${this.gatewayUrl}`);
    console.log(`   Webhook: ${this.webhookUrl ? "Configured" : "Not configured"}`);
  }
  
  // ==========================================================================
  // Template Loading
  // ==========================================================================
  
  private loadTemplates(templatesPath: string): Templates {
    try {
      const content = fs.readFileSync(templatesPath, "utf-8");
      const templates = yaml.parse(content) as Templates;
      console.log(`✅ Loaded ${Object.keys(templates.templates).length} message templates`);
      return templates;
    } catch (error) {
      console.error(`❌ Failed to load templates from ${templatesPath}:`, error);
      throw error;
    }
  }
  
  // ==========================================================================
  // Event Listening
  // ==========================================================================
  
  public start(): void {
    console.log("🎯 Starting Auto-Logger...");
    
    // Connect to SSE stream
    this.eventSource = new EventSource(this.sseUrl);
    
    this.eventSource.onopen = () => {
      console.log("✅ Connected to OASIS event stream");
    };
    
    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleEvent(data);
      } catch (error) {
        console.error("❌ Failed to parse event:", error);
      }
    };
    
    this.eventSource.onerror = (error) => {
      console.error("❌ SSE connection error:", error);
      // Reconnect logic handled by EventSource automatically
    };
    
    // Start batch processing timer
    this.startBatchTimer();
    
    console.log("✅ Auto-Logger is running");
  }
  
  public stop(): void {
    console.log("🛑 Stopping Auto-Logger...");
    
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    
    console.log("✅ Auto-Logger stopped");
  }
  
  // ==========================================================================
  // Event Handling
  // ==========================================================================
  
  private handleEvent(event: TickerEvent): void {
    const { kind, vtid } = event;
    
    // Check if event should be excluded
    if (this.templates.config.excluded_events.includes(kind)) {
      return;
    }
    
    console.log(`📥 Event received: ${vtid} / ${kind} / ${event.status}`);
    
    // Check if this is a priority event (immediate processing)
    if (this.templates.config.priority_events.includes(kind)) {
      this.processEventImmediately(event);
      return;
    }
    
    // Otherwise, add to batch
    this.addToBatch(event);
  }
  
  private addToBatch(event: TickerEvent): void {
    const key = `${event.vtid}:${event.kind}`;
    
    if (!this.eventBatches.has(key)) {
      this.eventBatches.set(key, {
        vtid: event.vtid,
        events: [event],
        firstSeen: new Date()
      });
    } else {
      const batch = this.eventBatches.get(key)!;
      batch.events.push(event);
    }
  }
  
  private processEventImmediately(event: TickerEvent): void {
    console.log(`⚡ Processing priority event: ${event.kind}`);
    
    // Generate summary
    const summary = this.generateSummary(event);
    
    if (summary) {
      // Post to OASIS
      this.postToOASIS(event.vtid, summary);
      
      // Post to DevOps Chat
      if (this.webhookUrl) {
        this.postToDevOpsChat(summary);
      }
    }
  }
  
  // ==========================================================================
  // Batch Processing
  // ==========================================================================
  
  private startBatchTimer(): void {
    this.batchTimer = setInterval(() => {
      this.processBatches();
    }, this.templates.config.batch_window * 1000);
  }
  
  private processBatches(): void {
    const now = new Date();
    
    for (const [key, batch] of this.eventBatches.entries()) {
      const age = (now.getTime() - batch.firstSeen.getTime()) / 1000;
      
      // Process batch if:
      // 1. It's older than batch_window
      // 2. It has more than batch_threshold events
      if (age >= this.templates.config.batch_window || 
          batch.events.length >= this.templates.config.batch_threshold) {
        
        console.log(`📦 Processing batch: ${key} (${batch.events.length} events)`);
        this.processBatch(batch);
        this.eventBatches.delete(key);
      }
    }
  }
  
  private processBatch(batch: EventBatch): void {
    // Generate batch summary
    const summary = this.generateBatchSummary(batch);
    
    if (summary) {
      // Post to OASIS
      this.postToOASIS(batch.vtid, summary);
      
      // Post to DevOps Chat
      if (this.webhookUrl) {
        this.postToDevOpsChat(summary);
      }
    }
  }
  
  // ==========================================================================
  // Summary Generation
  // ==========================================================================
  
  private generateSummary(event: TickerEvent): { title: string; message: string } | null {
    const template = this.templates.templates[event.kind];
    
    if (!template) {
      console.log(`⚠️  No template found for event kind: ${event.kind}`);
      return null;
    }
    
    // Prepare variables for template
    const variables: Record<string, any> = {
      vtid: event.vtid,
      title: event.title,
      status: event.status,
      layer: event.layer,
      module: event.module,
      source: event.source,
      kind: event.kind,
      timestamp: new Date(event.ts).toLocaleString(),
      link: event.link || "N/A",
      status_icon: this.templates.config.status_icons[event.status] || "•",
      ...event.meta
    };
    
    // Fill template
    const title = this.fillTemplate(template.title, variables);
    const message = this.fillTemplate(template.message, variables);
    
    return { title, message };
  }
  
  private generateBatchSummary(batch: EventBatch): { title: string; message: string } | null {
    const firstEvent = batch.events[0];
    const kind = firstEvent.kind;
    
    // Check if there's a batch template
    const batchTemplate = this.templates.templates[`${kind}.batch`] || 
                          this.templates.templates[kind];
    
    if (!batchTemplate) {
      return null;
    }
    
    // Aggregate batch statistics
    const successCount = batch.events.filter(e => e.status === "success").length;
    const failureCount = batch.events.filter(e => e.status === "failure").length;
    const totalEvents = batch.events.length;
    
    const variables: Record<string, any> = {
      vtid: batch.vtid,
      kind: kind,
      count: totalEvents,
      success_count: successCount,
      failure_count: failureCount,
      success_rate: ((successCount / totalEvents) * 100).toFixed(1),
      timestamp: new Date().toLocaleString(),
      period: `${this.templates.config.batch_window}s`,
      event_count: totalEvents
    };
    
    const title = this.fillTemplate(batchTemplate.title, variables);
    const message = this.fillTemplate(batchTemplate.message, variables);
    
    return { title, message };
  }
  
  private fillTemplate(template: string, variables: Record<string, any>): string {
    let result = template;
    
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{${key}}`;
      result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 
                              String(value || "N/A"));
    }
    
    return result;
  }
  
  // ==========================================================================
  // Output - OASIS
  // ==========================================================================
  
  private async postToOASIS(vtid: string, summary: { title: string; message: string }): Promise<void> {
    try {
      const payload = {
        id: randomUUID(),
        created_at: new Date().toISOString(),
        vtid: vtid,
        layer: "AUTO",
        module: "LOGGER",
        source: "auto_logger",
        kind: "vtid.update",
        status: "info",
        title: summary.title,
        ref: `vt/${vtid}-auto-update`,
        link: null,
        meta: {
          message: summary.message,
          auto_generated: true,
          timestamp: new Date().toISOString()
        }
      };
      
      const response = await fetch(`${this.supabaseUrl}/rest/v1/oasis_events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": this.supabaseKey,
          "Authorization": `Bearer ${this.supabaseKey}`,
          "Prefer": "return=representation"
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        const error = await response.text();
        console.error(`❌ Failed to post to OASIS: ${response.status} - ${error}`);
        return;
      }
      
      console.log(`✅ Posted to OASIS: ${vtid} - ${summary.title}`);
      
    } catch (error) {
      console.error("❌ Error posting to OASIS:", error);
    }
  }
  
  // ==========================================================================
  // Output - DevOps Chat
  // ==========================================================================
  
  private async postToDevOpsChat(summary: { title: string; message: string }): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }
    
    try {
      // Format for Slack/Discord/Teams webhook
      const payload = {
        text: summary.title,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: summary.title
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: summary.message
            }
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `🤖 Auto-generated by Auto-Logger | ${new Date().toLocaleString()}`
              }
            ]
          }
        ]
      };
      
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        console.error(`❌ Failed to post to DevOps Chat: ${response.status}`);
        return;
      }
      
      console.log(`✅ Posted to DevOps Chat: ${summary.title}`);
      
    } catch (error) {
      console.error("❌ Error posting to DevOps Chat:", error);
    }
  }
  
  // ==========================================================================
  // Manual Trigger (for testing)
  // ==========================================================================
  
  public async generateReport(vtid: string): Promise<void> {
    console.log(`📊 Generating report for ${vtid}...`);
    
    try {
      // Query OASIS for all events for this VTID
      const response = await fetch(
        `${this.supabaseUrl}/rest/v1/oasis_events?vtid=eq.${vtid}&order=created_at.asc`,
        {
          headers: {
            "apikey": this.supabaseKey,
            "Authorization": `Bearer ${this.supabaseKey}`
          }
        }
      );
      
      if (!response.ok) {
        console.error(`❌ Failed to query OASIS: ${response.status}`);
        return;
      }
      
      const events = await response.json();
      console.log(`   Found ${events.length} events for ${vtid}`);
      
      // Generate comprehensive report
      const report = this.generateComprehensiveReport(vtid, events);
      
      // Post report
      await this.postToOASIS(vtid, report);
      
      if (this.webhookUrl) {
        await this.postToDevOpsChat(report);
      }
      
      console.log(`✅ Report generated for ${vtid}`);
      
    } catch (error) {
      console.error("❌ Error generating report:", error);
    }
  }
  
  private generateComprehensiveReport(vtid: string, events: any[]): { title: string; message: string } {
    const eventsByKind: Record<string, number> = {};
    const eventsByStatus: Record<string, number> = {};
    
    events.forEach(event => {
      eventsByKind[event.kind] = (eventsByKind[event.kind] || 0) + 1;
      eventsByStatus[event.status] = (eventsByStatus[event.status] || 0) + 1;
    });
    
    const message = `**VTID Activity Report**

**Total Events:** ${events.length}

**Events by Type:**
${Object.entries(eventsByKind)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([kind, count]) => `- ${kind}: ${count}`)
  .join('\n')}

**Events by Status:**
${Object.entries(eventsByStatus)
  .map(([status, count]) => `- ${status}: ${count}`)
  .join('\n')}

**Timeline:**
- First event: ${new Date(events[0]?.created_at).toLocaleString()}
- Last event: ${new Date(events[events.length - 1]?.created_at).toLocaleString()}

**Report generated:** ${new Date().toLocaleString()}`;
    
    return {
      title: `📊 Activity Report: ${vtid}`,
      message
    };
  }
}

// ============================================================================
// Export
// ============================================================================

export default AutoLogger;
