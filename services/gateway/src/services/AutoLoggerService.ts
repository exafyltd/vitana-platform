import * as yaml from 'js-yaml';
import { autoLoggerMetrics } from './AutoLoggerMetrics';
import * as path from 'path';
import * as fs from 'fs';

interface OasisEvent {
  rid: string;
  service: string;
  event: string;
  tenant: string;
  status: string;
  notes?: string;
  metadata?: Record<string, any>;
}

interface Template {
  priority: string;
  message: string;
}

export class AutoLoggerService {
  private templates: Record<string, Template> = {};
  private webhookUrl: string;

  constructor() {
    this.webhookUrl = process.env.DEVOPS_CHAT_WEBHOOK || '';
    console.log("[Auto-Logger] constructor start");
    console.log("[Auto-Logger] webhook configured =", !!this.webhookUrl);
    this.loadTemplates();
  }

  private loadTemplates(): void {
    try {
      const templatePath = path.join(__dirname, '../../config/auto_logger_templates.yaml');
      console.log("[Auto-Logger] template path =", templatePath);
      const fileContents = fs.readFileSync(templatePath, 'utf8');
      const config: any = yaml.load(fileContents);
      this.templates = config.templates || {};
      console.log(`✅ Auto-Logger loaded ${Object.keys(this.templates).length} templates`);
    } catch (error) {
      autoLoggerMetrics.incrementFailed();
      console.error('⚠️  Auto-Logger: Failed to load templates:', error);
      this.templates = {};
    }
  }

  public async processEvent(event: OasisEvent): Promise<void> {
    if (!this.webhookUrl) {
      return;
    }

    const eventKey = `${event.service}.${event.event}`;
    const template = this.templates[eventKey] || this.templates['default'];
    
    if (!template) {
      autoLoggerMetrics.incrementTemplateMissing();
      return;
    }

    const message = this.formatMessage(template.message, event);
    await this.postToChat(message);
    
    if (event.metadata?.vtid) {
      await this.postVtidUpdate(event, message);
    }
  }

  private formatMessage(template: string, event: OasisEvent): string {
    let msg = template;
    
    // Create event_type from service.event
    const eventType = `${event.service}.${event.event}`;
    
    // Replace top-level fields
    msg = msg.replace(/{service}/g, event.service);
    msg = msg.replace(/{event}/g, event.event);
    msg = msg.replace(/{event_type}/g, eventType);
    msg = msg.replace(/{status}/g, event.status);
    msg = msg.replace(/{tenant}/g, event.tenant);
    msg = msg.replace(/{notes}/g, event.notes || '');
    msg = msg.replace(/{environment}/g, event.metadata?.environment || 'unknown');
    
    // Replace {vtid} - check both top-level and metadata
    const vtid = event.metadata?.vtid || '';
    msg = msg.replace(/{vtid}/g, vtid);
    
    // Replace metadata fields like {metadata.title}
    msg = msg.replace(/{metadata\.(\w+)}/g, (_: string, key: string) => {
      return event.metadata?.[key]?.toString() || '';
    });
    
    return msg;
  }

  private async postToChat(message: string): Promise<void> {
    if (!this.webhookUrl) {
      console.log("[Auto-Logger] postToChat skipped – no webhookUrl");
      return;
    }

    try {
      console.log("[Auto-Logger] posting to Google Chat, message length =", message.length);
      const resp = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });

      const body = await resp.text();
      console.log("[Auto-Logger] chat response status =", resp.status, "body =", body);

      if (!resp.ok) {
        console.error('[Auto-Logger] chat post failed');
      }
    } catch (error) {
      autoLoggerMetrics.incrementFailed();
      console.error('[Auto-Logger] chat post error:', error);
    }
  }

  private async postVtidUpdate(event: OasisEvent, summary: string): Promise<void> {
    try {
      const supabaseUrl = process.env.SUPABASE_URL;
      const svcKey = process.env.SUPABASE_SERVICE_ROLE;
      
      if (!supabaseUrl || !svcKey) return;

      const payload = {
        rid: crypto.randomUUID(),
        service: 'auto-logger',
        event: 'vtid.update',
        tenant: event.tenant,
        status: 'info',
        notes: summary,
        metadata: {
          original_event: `${event.service}.${event.event}`,
          vtid: event.metadata?.vtid,
        },
      };

      await fetch(`${supabaseUrl}/rest/v1/OasisEvent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: svcKey,
          Authorization: `Bearer ${svcKey}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      autoLoggerMetrics.incrementFailed();
      console.error('[Auto-Logger] OASIS update error:', error);
    }
  }
}
