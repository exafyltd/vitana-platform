/**
 * VTID-02100: Connector registry + loader.
 *
 * Each connector module default-exports an object implementing `Connector`.
 * This file imports them all and registers into a Map keyed by id.
 *
 * Adding a new connector = create file under connectors/{category}/{id}.ts
 * and add one import line below. No switch statements, no PROVIDER_CONFIGS
 * dictionary to edit.
 */

import type { Connector, ConnectorMetadata } from './types';
import terraConnector from './wearable/terra';
import vitalConnector from './wearable/vital';
import fitbitConnector from './wearable/fitbit';
import ouraConnector from './wearable/oura';
import stravaConnector from './wearable/strava';

const CONNECTORS = new Map<string, Connector>();

function register(c: Connector): void {
  if (CONNECTORS.has(c.id)) {
    console.warn(`[connectors] duplicate registration for ${c.id}, ignoring second`);
    return;
  }
  CONNECTORS.set(c.id, c);
}

// ---- Register each connector here ----
register(terraConnector);
register(vitalConnector);
register(fitbitConnector);
register(ouraConnector);
register(stravaConnector);

export function getConnector(id: string): Connector | undefined {
  return CONNECTORS.get(id);
}

export function listConnectors(): ConnectorMetadata[] {
  return Array.from(CONNECTORS.values()).map((c) => ({
    id: c.id,
    category: c.category,
    display_name: c.display_name,
    auth_type: c.auth_type,
    capabilities: c.capabilities,
    enabled: true,
  }));
}

export function listConnectorsByCategory(category: string): Connector[] {
  return Array.from(CONNECTORS.values()).filter((c) => c.category === category);
}

export async function initializeAllConnectors(): Promise<void> {
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const c of CONNECTORS.values()) {
    if (!c.initialize) {
      results.push({ id: c.id, ok: true });
      continue;
    }
    try {
      await c.initialize();
      results.push({ id: c.id, ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ id: c.id, ok: false, error: message });
      console.error(`[connectors] init failed for ${c.id}:`, message);
    }
  }
  console.log(`[connectors] initialized ${results.filter((r) => r.ok).length}/${results.length}`);
}

export type { Connector, ConnectorMetadata } from './types';
