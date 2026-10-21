/**
 * Maxina listener adapter — stub implementation.
 *
 * Maxina's technical shape (own app, Slack-alike, forum, etc.) is not yet
 * finalized. This adapter uses a generic "polling REST endpoint" contract
 * so we can flip to whatever Maxina ends up being without touching the
 * observe loop. Config shape:
 *
 *   {
 *     "endpoint": "https://maxina.example.com/api/channels/{channel_key}/messages",
 *     "auth_header": "Bearer <token>",
 *     "since_param": "since"
 *   }
 *
 * Expected response: { messages: IncomingMessage[], next_cursor?: string }
 * If the endpoint isn't set, the adapter returns an empty result — safe
 * no-op that lets Phase 1 ship before Maxina's API exists.
 */

import fetch from 'node-fetch';
import type { IngestResult, ListenerAdapter, ListenerChannelRecord, IncomingMessage } from './types';

interface MaxinaConfig {
  endpoint?: string;
  auth_header?: string;
  since_param?: string;
  max_messages?: number;
}

export class MaxinaAdapter implements ListenerAdapter {
  platform = 'maxina';

  async ingest(channel: ListenerChannelRecord): Promise<IngestResult> {
    const cfg = (channel.config || {}) as MaxinaConfig;

    if (!cfg.endpoint) {
      return { messages: [], next_cursor: channel.last_ingest_cursor };
    }

    const url = new URL(cfg.endpoint.replace('{channel_key}', encodeURIComponent(channel.channel_key)));
    if (channel.last_ingest_cursor) {
      url.searchParams.set(cfg.since_param || 'since', channel.last_ingest_cursor);
    }
    if (cfg.max_messages) {
      url.searchParams.set('limit', String(cfg.max_messages));
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.auth_header) headers['Authorization'] = cfg.auth_header;

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      throw new Error(`maxina ingest ${res.status}: ${await res.text().catch(() => '')}`);
    }

    const body = (await res.json()) as { messages?: unknown[]; next_cursor?: string };
    const messages: IncomingMessage[] = Array.isArray(body.messages)
      ? body.messages.map(normalizeMessage).filter((m): m is IncomingMessage => m !== null)
      : [];

    return { messages, next_cursor: body.next_cursor ?? channel.last_ingest_cursor };
  }
}

function normalizeMessage(raw: unknown): IncomingMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : typeof r.external_message_id === 'string' ? r.external_message_id : null;
  const body = typeof r.body === 'string' ? r.body : typeof r.text === 'string' ? r.text : null;
  if (!id || !body) return null;

  return {
    external_message_id: id,
    platform: 'maxina',
    author_handle: typeof r.author_handle === 'string' ? r.author_handle : typeof r.author === 'string' ? r.author : undefined,
    author_external_id: typeof r.author_id === 'string' ? r.author_id : undefined,
    body,
    url: typeof r.url === 'string' ? r.url : undefined,
    posted_at: typeof r.posted_at === 'string' ? r.posted_at : typeof r.created_at === 'string' ? r.created_at : undefined,
  };
}
