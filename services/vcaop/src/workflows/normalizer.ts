/**
 * Partner event normalization (Phase 4, brief Sec. 9):
 * partner event → canonical NormalizedEvent, using the certified manifest's
 * canonical mappings. Data minimization by construction: only mapped fields
 * cross the boundary; everything else is DROPPED and listed, never forwarded.
 */
import * as crypto from 'crypto';
import { CanonicalEntityType } from '../canonical/model';
import { ConnectorManifest } from '../factory/manifest';

export interface NormalizedEventRecord {
  /** Deterministic id: hash of (connector, event key, native id) — the dedup anchor. */
  id: string;
  correlationId: string;
  tenantId: string;
  connectorId: string;
  eventKey: string;
  entityType: CanonicalEntityType | 'unknown';
  sourceNativeId: string;
  canonical: Record<string, unknown>;
  droppedFields: string[];
  receivedAt: string;
}

export interface RawPartnerEvent {
  eventKey: string;
  /** Which declared source schema the payload conforms to. */
  schemaName: string;
  /** Native id of the subject entity at the partner (e.g. their order id). */
  nativeId: string;
  payload: Record<string, unknown>;
  receivedAt?: string;
}

export function normalizeEvent(
  manifest: ConnectorManifest,
  raw: RawPartnerEvent,
): NormalizedEventRecord {
  const mappings = manifest.canonical_mappings.filter((m) => m.source_schema === raw.schemaName);
  const canonical: Record<string, unknown> = {};
  const mappedSources = new Set<string>();
  let entityType: NormalizedEventRecord['entityType'] = 'unknown';

  for (const m of mappings) {
    if (m.source_field in raw.payload) {
      canonical[m.canonical_field] = raw.payload[m.source_field];
      mappedSources.add(m.source_field);
      entityType = m.canonical_entity;
    }
  }
  const droppedFields = Object.keys(raw.payload).filter((k) => !mappedSources.has(k));

  const id = crypto
    .createHash('sha256')
    .update(`${manifest.connector_id}:${raw.eventKey}:${raw.nativeId}:${JSON.stringify(raw.payload)}`)
    .digest('hex')
    .slice(0, 32);

  return {
    id,
    correlationId: `${manifest.connector_id}:${raw.nativeId}`,
    tenantId: manifest.partner_tenant_id,
    connectorId: manifest.connector_id,
    eventKey: raw.eventKey,
    entityType,
    sourceNativeId: raw.nativeId,
    canonical,
    droppedFields,
    receivedAt: raw.receivedAt ?? new Date().toISOString(),
  };
}
