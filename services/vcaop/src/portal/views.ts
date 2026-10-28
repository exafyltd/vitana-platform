/**
 * Partner Portal view models (Phase 3, BLK-008 pattern) — framework-agnostic
 * presenters the React components bind to later. Discipline matches src/ui/:
 * every view is derived, contains NO secrets/refs/PII, and states exactly
 * what the business is approving (brief Sec. 8 item 7).
 */
import { ConnectionRecord } from './onboarding-service';

const REF_KEY = /(secret|credential|token|_ref$)/i;

/** Deep-strip anything ref/secret-shaped — defense in depth for views. */
function stripSensitive<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSensitive(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REF_KEY.test(k)) continue;
      out[k] = stripSensitive(v);
    }
    return out as unknown as T;
  }
  return value;
}

export interface ConnectionListItemView {
  id: string;
  name: string;
  state: string;
  connector_id: string;
  updated_at: string;
}

export function presentConnectionList(records: ConnectionRecord[]): ConnectionListItemView[] {
  return records.map((r) => ({
    id: r.id,
    name: r.name,
    state: r.state,
    connector_id: r.connectorId,
    updated_at: r.updatedAt,
  }));
}

export interface MappingPreviewView {
  connection_id: string;
  state: string;
  mappings: Array<{
    source: string;
    canonical: string;
    confidence: number;
    decided_by: string;
    sensitive: boolean;
    needs_review: boolean;
  }>;
  warnings: string[];
  pending_review_count: number;
}

export function presentMappingPreview(rec: ConnectionRecord, minConfidence = 0.7): MappingPreviewView {
  const mappings = (rec.manifest?.canonical_mappings ?? []).map((m) => {
    const approved = rec.decisions.some(
      (d) => d.source_schema === m.source_schema && d.source_field === m.source_field && d.decision === 'approve',
    );
    const needsReview = !approved && (m.sensitive || (m.decided_by === 'ai' && m.confidence < minConfidence));
    return {
      source: `${m.source_schema}.${m.source_field}`,
      canonical: `${m.canonical_entity}.${m.canonical_field}`,
      confidence: m.confidence,
      decided_by: m.decided_by,
      sensitive: m.sensitive,
      needs_review: needsReview,
    };
  });
  return {
    connection_id: rec.id,
    state: rec.state,
    mappings,
    warnings: rec.warnings,
    pending_review_count: mappings.filter((m) => m.needs_review).length,
  };
}

/**
 * What the business sees before giving THE one activation approval
 * (brief Sec. 8 item 7): capabilities, scopes, data read, actions that may
 * be performed, events exchanged, risks + human-approval requirements.
 */
export interface ActivationSummaryView {
  connection_id: string;
  name: string;
  state: string;
  connector_id: string;
  risk_level: string;
  jurisdiction: string;
  auth_mechanism: string;
  requested_scopes: string[];
  capabilities: Array<{ key: string; kind: string; description: string }>;
  data_read: string[]; // canonical entities that will be read
  actions: Array<{ key: string; destructive: boolean; human_gated: boolean }>;
  events: string[];
  human_approval_required_for: string[];
  test_summary: { total: number; passed: number } | null;
  certification_status: string | null;
  /** Fees are configuration, not yet wired — surfaced honestly as pending. */
  expected_fees: string;
}

export function presentActivationSummary(rec: ConnectionRecord): ActivationSummaryView {
  const m = rec.manifest;
  const tests = rec.certification?.testResults ?? null;
  return stripSensitive({
    connection_id: rec.id,
    name: rec.name,
    state: rec.state,
    connector_id: rec.connectorId,
    risk_level: m?.risk_level ?? 'unknown',
    jurisdiction: m?.jurisdiction ?? 'unknown',
    auth_mechanism: m?.auth.mechanism ?? 'unknown',
    requested_scopes: m?.auth.scopes ?? [],
    capabilities: m?.capabilities ?? [],
    data_read: [...new Set((m?.canonical_mappings ?? []).map((x) => x.canonical_entity))],
    actions: (m?.actions ?? [])
      .filter((a) => a.kind === 'action')
      .map((a) => ({ key: a.key, destructive: a.destructive, human_gated: a.human_gated })),
    events: (m?.events ?? []).map((e) => e.key),
    human_approval_required_for: (m?.actions ?? []).filter((a) => a.human_gated).map((a) => a.key),
    test_summary: tests ? { total: tests.length, passed: tests.filter((t) => t.passed).length } : null,
    certification_status: rec.certification?.status ?? null,
    expected_fees: 'fee schedule pending platform configuration (Phase 6)',
  });
}
