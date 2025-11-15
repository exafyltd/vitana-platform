/**
 * DEV-OASIS-0109: Shared Event Broadcaster
 * Singleton managing SSE clients and event cache for real-time updates
 */

import { Response } from 'express';

export interface TickerEvent {
  ts: string;
  vtid?: string | null;
  layer?: string | null;
  module?: string;
  source?: string;
  kind?: string;
  status?: string;
  title?: string;
  ref?: string | null;
  link?: string | null;
  type?: string;
}

class EventBroadcaster {
  private clients: Set<Response> = new Set();
  private eventCache: TickerEvent[] = [];
  private readonly MAX_CACHE_SIZE = 20;

  addClient(res: Response): void {
    this.clients.add(res);
    console.log(`✅ SSE client connected (total: ${this.clients.size})`);
  }

  removeClient(res: Response): void {
    this.clients.delete(res);
    console.log(`👋 SSE client disconnected (remaining: ${this.clients.size})`);
  }

  broadcast(event: TickerEvent): void {
    this.eventCache.unshift(event);
    if (this.eventCache.length > this.MAX_CACHE_SIZE) {
      this.eventCache = this.eventCache.slice(0, this.MAX_CACHE_SIZE);
    }

    const data = `data: ${JSON.stringify(event)}\n\n`;
    const deadClients: Response[] = [];
    
    this.clients.forEach((client) => {
      try {
        client.write(data);
      } catch (err) {
        console.error("❌ Failed to write to SSE client:", err);
        deadClients.push(client);
      }
    });

    deadClients.forEach(client => this.clients.delete(client));
    
    if (this.clients.size > 0) {
      console.log(`📡 Broadcasted event to ${this.clients.size} client(s)`);
    }
  }

  getCachedEvents(): TickerEvent[] {
    return [...this.eventCache];
  }

  updateCache(events: TickerEvent[]): void {
    events.forEach((event) => {
      this.eventCache.unshift(event);
    });
    if (this.eventCache.length > this.MAX_CACHE_SIZE) {
      this.eventCache = this.eventCache.slice(0, this.MAX_CACHE_SIZE);
    }
  }
}

export const eventBroadcaster = new EventBroadcaster();
