import EventSource from 'eventsource';
import * as yaml from 'js-yaml';
import * as fs from 'fs';

const CONFIG = {
  OASIS_API_URL: process.env.OASIS_API_URL || 'https://oasis-api.vitana.app',
  DEVOPS_CHAT_WEBHOOK: process.env.DEVOPS_CHAT_WEBHOOK || '',
};

export class AutoLoggerService {
  private templates: any = {};
  private eventSource: any = null;

  constructor() {
    const config: any = yaml.load(fs.readFileSync('/app/config/auto_logger_templates.yaml', 'utf8'));
    this.templates = config.templates;
    console.log(`Loaded ${Object.keys(this.templates).length} templates`);
  }

  public async start(): Promise<void> {
    const url = `${CONFIG.OASIS_API_URL}/events/stream`;
    console.log(`Connecting to: ${url}`);
    this.eventSource = new (EventSource as any)(url);
    this.eventSource.onopen = () => console.log('✅ Connected to OASIS');
    this.eventSource.onmessage = (e: any) => this.handleEvent(JSON.parse(e.data));
    this.eventSource.onerror = (err: any) => console.error('SSE error:', err);
  }

  public async stop(): Promise<void> {
    if (this.eventSource) this.eventSource.close();
  }

  private handleEvent(event: any): void {
    const template = this.templates[event.event_type] || this.templates['default'];
    if (!template) return;
    
    const message = template.message
      .replace(/{vtid}/g, event.vtid || 'N/A')
      .replace(/{event_type}/g, event.event_type)
      .replace(/{actor}/g, event.actor)
      .replace(/{environment}/g, event.environment)
      .replace(/{metadata\.(\w+)}/g, (_: string, k: string) => event.metadata?.[k] || '');
    
    // Post to OASIS
    fetch(`${CONFIG.OASIS_API_URL}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_type: 'vtid.update',
        vtid: event.vtid,
        source_service: 'auto-logger',
        actor: 'auto-logger',
        environment: event.environment,
        metadata: { summary: message },
      }),
    }).catch(e => console.error('OASIS post failed:', e));
    
    // Post to Google Chat (Command HUB)
    if (CONFIG.DEVOPS_CHAT_WEBHOOK) {
      fetch(CONFIG.DEVOPS_CHAT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      }).catch(e => console.error('Chat post failed:', e));
    }
  }
}
