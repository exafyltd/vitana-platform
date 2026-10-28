import { MaxinaAdapter } from './maxina-adapter';
import type { ListenerAdapter } from './types';

const registry: Record<string, ListenerAdapter> = {
  maxina: new MaxinaAdapter(),
};

export function getListenerAdapter(platform: string): ListenerAdapter | null {
  return registry[platform] || null;
}

export function registerListenerAdapter(adapter: ListenerAdapter): void {
  registry[adapter.platform] = adapter;
}

export type { ListenerAdapter, IncomingMessage, IngestResult, ListenerChannelRecord } from './types';
