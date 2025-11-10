/**
 * Google Chat Notification Service
 * VTID: DEV-COMMU-GCHAT-NOTIFY
 * 
 * Sends formatted notifications to Google Chat Command Hub space
 * for important VTID events with rate limiting and filtering.
 */

interface NotificationEvent {
  vtid?: string;
  topic: string;
  service: string;
  status: string;
  message: string;
  link?: string;
  created_at?: string;
}

interface NotificationConfig {
  webhookUrl: string;
  rateLimit: {
    maxPerMinute: number;
    lastSentMap: Map<string, number>;
  };
}

export class GChatNotifierService {
  private config: NotificationConfig;
  
  // Topics that trigger notifications
  private notifiableTopics = new Set([
    'vtid.created',
    'vtid.status.updated',
    'task.completed',
    'task.failed',
    'deployment.started',
    'deployment.success',
    'deployment.failed',
    'workflow.success',
    'workflow.failure',
    'pr.merged',
  ]);

  constructor(webhookUrl: string) {
    this.config = {
      webhookUrl,
      rateLimit: {
        maxPerMinute: 10,
        lastSentMap: new Map(),
      },
    };
  }

  /**
   * Process event and send notification if applicable
   */
  async processEvent(event: NotificationEvent): Promise<boolean> {
    // Skip if topic not in notification list
    if (!this.notifiableTopics.has(event.topic)) {
      return false;
    }

    // Check rate limit
    if (!this.checkRateLimit(event.topic)) {
      console.log(`⏸️ Rate limited: ${event.topic}`);
      return false;
    }

    // Format and send message
    try {
      const message = this.formatMessage(event);
      await this.sendToGChat(message);
      
      console.log(`📤 GChat notification sent: ${event.vtid || event.topic}`);
      return true;
    } catch (error: any) {
      console.error('❌ Failed to send GChat notification:', error.message);
      return false;
    }
  }

  /**
   * Check rate limit for topic
   */
  private checkRateLimit(topic: string): boolean {
    const now = Date.now();
    const lastSent = this.config.rateLimit.lastSentMap.get(topic) || 0;
    const timeSinceLastSent = now - lastSent;
    
    // Allow if more than 6 seconds since last message for this topic
    if (timeSinceLastSent < 6000) {
      return false;
    }
    
    // Update last sent time
    this.config.rateLimit.lastSentMap.set(topic, now);
    
    // Cleanup old entries (older than 1 minute)
    for (const [key, value] of this.config.rateLimit.lastSentMap.entries()) {
      if (now - value > 60000) {
        this.config.rateLimit.lastSentMap.delete(key);
      }
    }
    
    return true;
  }

  /**
   * Format event as Google Chat message
   */
  private formatMessage(event: NotificationEvent): any {
    const icon = this.getIconForStatus(event.status);
    
    const header = event.vtid 
      ? `${icon} VTID: ${event.vtid}`
      : `${icon} ${event.topic}`;
    
    const commandHubUrl = process.env.COMMAND_HUB_URL || 
                          'https://vitana-dev-gateway-86804897789.us-central1.run.app/command-hub';
    
    const vtidLink = event.vtid 
      ? `${commandHubUrl}?vtid=${event.vtid}`
      : null;

    return {
      cards: [
        {
          header: {
            title: header,
            subtitle: event.topic,
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: `<b>Status:</b> ${event.status.toUpperCase()}<br>` +
                          `<b>Service:</b> ${event.service}<br>` +
                          `<b>Message:</b> ${event.message}`,
                  },
                },
                ...(vtidLink ? [
                  {
                    buttons: [
                      {
                        textButton: {
                          text: 'View in Command HUB',
                          onClick: {
                            openLink: {
                              url: vtidLink,
                            },
                          },
                        },
                      },
                    ],
                  },
                ] : []),
              ],
            },
          ],
        },
      ],
    };
  }

  /**
   * Get icon for status
   */
  private getIconForStatus(status: string): string {
    const icons: Record<string, string> = {
      success: '✅',
      complete: '✅',
      error: '❌',
      failure: '❌',
      failed: '❌',
      warning: '⚠️',
      blocked: '🚫',
      info: 'ℹ️',
      pending: '⏳',
      active: '🔄',
      review: '👀',
    };
    
    return icons[status.toLowerCase()] || 'ℹ️';
  }

  /**
   * Send message to Google Chat
   */
  private async sendToGChat(message: any): Promise<void> {
    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GChat webhook failed: ${response.status} - ${text}`);
    }
  }
}
