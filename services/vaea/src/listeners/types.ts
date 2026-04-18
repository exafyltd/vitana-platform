export interface IncomingMessage {
  external_message_id: string;
  platform: string;
  author_handle?: string;
  author_external_id?: string;
  body: string;
  url?: string;
  posted_at?: string;
}

export interface ListenerChannelRecord {
  id: string;
  tenant_id: string;
  user_id: string;
  platform: string;
  channel_key: string;
  config: Record<string, unknown>;
  last_ingest_cursor: string | null;
  dry_run: boolean;
}

export interface IngestResult {
  messages: IncomingMessage[];
  next_cursor?: string | null;
}

export interface ListenerAdapter {
  platform: string;
  ingest(channel: ListenerChannelRecord): Promise<IngestResult>;
}
