/**
 * OpenAPI ingestion — stage 1-7 of the AI Integration Builder (brief Sec. 5):
 * discover entities/actions/schemas from an OpenAPI 3 document and emit a
 * DRAFT ConnectorManifest with confidence-scored canonical mapping proposals.
 *
 * Deterministic by design: the scoring here is a transparent lexical model
 * (exact > token-overlap > substring), not an LLM call — an LLM proposer can
 * later feed *candidates* into the same MappingDecision review flow, but the
 * pipeline must not depend on one (AI plans, deterministic systems execute).
 * Low-confidence and sensitive proposals are flagged, never auto-certified.
 */
import * as crypto from 'crypto';
import {
  CANONICAL_FIELDS,
  CanonicalEntityType,
  SENSITIVE_FIELD_PATTERN,
} from '../canonical/model';
import { ConnectorManifest, ManifestAction, ManifestField, ManifestMapping } from './manifest';

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  requestBody?: { content?: Record<string, { schema?: SchemaObj }> };
  responses?: Record<string, { content?: Record<string, { schema?: SchemaObj }> }>;
}
interface SchemaObj {
  $ref?: string;
  type?: string;
  properties?: Record<string, SchemaObj>;
  required?: string[];
  items?: SchemaObj;
}
export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, SchemaObj>; securitySchemes?: Record<string, { type?: string; scheme?: string; flows?: unknown }> };
  webhooks?: Record<string, unknown>;
}

export interface IngestOptions {
  connectorId: string;
  partnerTenantId: string;
  providerId: string;
  jurisdiction?: string;
  secretRef?: string;
}

export interface IngestResult {
  draft: ConnectorManifest;
  warnings: string[];
}

const normalize = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // split camelCase before lowercasing
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
const tokens = (s: string): string[] => normalize(s).split('_').filter(Boolean);

/** Transparent lexical similarity in [0,1]: exact > token overlap > substring. */
export function fieldSimilarity(sourceField: string, canonicalField: string): number {
  const a = normalize(sourceField);
  const b = normalize(canonicalField);
  if (a === b) return 1;
  const ta = new Set(tokens(sourceField));
  const tb = new Set(tokens(canonicalField));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  if (inter > 0) return 0.5 + 0.4 * (inter / union);
  if (a.includes(b) || b.includes(a)) return 0.55;
  return 0;
}

/** Best canonical target for a source field across the given entity's dictionary. */
export function proposeMapping(
  sourceSchema: string,
  sourceField: string,
  entity: CanonicalEntityType,
): ManifestMapping | null {
  const dict = CANONICAL_FIELDS[entity] ?? [];
  let best: { field: string; score: number } | null = null;
  for (const cf of dict) {
    const score = fieldSimilarity(sourceField, cf);
    if (score > 0 && (!best || score > best.score)) best = { field: cf, score };
  }
  if (!best || best.score < 0.4) return null;
  const sensitive = SENSITIVE_FIELD_PATTERN.test(sourceField);
  return {
    source_schema: sourceSchema,
    source_field: sourceField,
    canonical_entity: entity,
    canonical_field: best.field,
    confidence: Math.round(best.score * 100) / 100,
    decided_by: 'ai',
    sensitive,
  };
}

/** Guess which canonical entity a partner schema describes, from its name + fields. */
export function guessEntity(schemaName: string, fieldNames: string[]): CanonicalEntityType | null {
  const name = normalize(schemaName);
  const candidates: CanonicalEntityType[] = ['product', 'offer', 'inventory', 'order', 'customer', 'shipment', 'invoice'];
  for (const c of candidates) {
    if (name.includes(c)) return c;
  }
  // Fall back to the entity whose dictionary overlaps the fields most.
  let best: { entity: CanonicalEntityType; hits: number } | null = null;
  for (const c of candidates) {
    const dict = CANONICAL_FIELDS[c] ?? [];
    const hits = fieldNames.filter((f) => dict.some((d) => fieldSimilarity(f, d) >= 0.5)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { entity: c, hits };
  }
  return best && best.hits >= 2 ? best.entity : null;
}

function extractFields(schema: SchemaObj | undefined): ManifestField[] {
  if (!schema?.properties) return [];
  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    type: (['string', 'number', 'boolean', 'object', 'array'].includes(prop.type ?? '')
      ? prop.type
      : prop.type === 'integer'
        ? 'number'
        : 'string') as ManifestField['type'],
    required: (schema.required ?? []).includes(name),
    sensitive: SENSITIVE_FIELD_PATTERN.test(name),
  }));
}

function schemaRefName(schema: SchemaObj | undefined): string | undefined {
  const ref = schema?.$ref ?? schema?.items?.$ref;
  return ref?.split('/').pop();
}

export function ingestOpenApi(doc: OpenApiDocument, opts: IngestOptions): IngestResult {
  const warnings: string[] = [];
  if (!doc.openapi?.startsWith('3')) warnings.push('Document does not declare OpenAPI 3.x — ingestion is best-effort');

  // 1. Source schemas
  const sourceSchemas = Object.entries(doc.components?.schemas ?? {}).map(([name, schema]) => ({
    name,
    fields: extractFields(schema),
    hash: crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 16),
  }));

  // 2. Actions from paths
  const actions: ManifestAction[] = [];
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      const httpMethod = method.toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(httpMethod)) continue;
      const isRead = httpMethod === 'GET';
      const destructive = httpMethod === 'DELETE';
      const key = op.operationId ?? `${method}_${normalize(path)}`;
      const okResponse = op.responses?.['200'] ?? op.responses?.['201'];
      actions.push({
        key,
        method: httpMethod as ManifestAction['method'],
        path,
        kind: isRead ? 'read' : 'action',
        destructive,
        // Writes default to idempotency keys; destructive calls are human-gated
        // until a human review relaxes it — conservative by default.
        human_gated: destructive,
        idempotency: isRead ? 'none' : 'idempotency_key',
        input_schema: schemaRefName(op.requestBody?.content?.['application/json']?.schema),
        output_schema: schemaRefName(okResponse?.content?.['application/json']?.schema),
      });
    }
  }
  if (actions.length === 0) warnings.push('No paths found — manifest will fail validation until actions exist');

  // 3. Canonical mapping proposals with confidence
  const mappings: ManifestMapping[] = [];
  for (const s of sourceSchemas) {
    const entity = guessEntity(s.name, s.fields.map((f) => f.name));
    if (!entity) {
      warnings.push(`Could not infer a canonical entity for schema '${s.name}' — needs human mapping`);
      continue;
    }
    for (const f of s.fields) {
      const proposal = proposeMapping(s.name, f.name, entity);
      if (proposal) mappings.push(proposal);
      else warnings.push(`No canonical target for ${s.name}.${f.name} (entity ${entity}) — needs human mapping`);
    }
  }

  // 4. Auth mechanism guess
  const schemes = Object.values(doc.components?.securitySchemes ?? {});
  const mechanism = schemes.some((s) => s.type === 'oauth2')
    ? ('oauth2_authorization_code' as const)
    : schemes.some((s) => s.type === 'apiKey')
      ? ('api_key' as const)
      : schemes.some((s) => s.type === 'http' && s.scheme === 'basic')
        ? ('basic' as const)
        : ('none' as const);
  if (mechanism === 'none') warnings.push('No security scheme found — verify the partner API is really unauthenticated');

  const readAction = actions.find((a) => a.kind === 'read');
  const draft: ConnectorManifest = {
    connector_id: opts.connectorId,
    version: '0.1.0',
    partner_tenant_id: opts.partnerTenantId,
    provider_id: opts.providerId,
    connection_type: 'openapi',
    auth: {
      mechanism,
      secret_refs: mechanism === 'none' ? [] : [opts.secretRef ?? `vault:${opts.connectorId}/auth`],
      scopes: [],
    },
    capabilities: [
      ...actions.filter((a) => a.kind === 'read').map((a) => ({ key: a.key, kind: 'read' as const, description: `Read via ${a.method} ${a.path}` })),
      ...actions.filter((a) => a.kind === 'action').map((a) => ({ key: a.key, kind: 'action' as const, description: `Action via ${a.method} ${a.path}` })),
      ...Object.keys(doc.webhooks ?? {}).map((k) => ({ key: k, kind: 'event' as const, description: `Webhook ${k}` })),
    ],
    source_schemas: sourceSchemas,
    canonical_mappings: mappings,
    actions,
    events: Object.keys(doc.webhooks ?? {}).map((k) => ({ key: k, source: 'webhook' as const })),
    rate_limits: { requests_per_minute: 60 },
    timeouts: { request_ms: 30_000, job_ms: 10 * 60_000 },
    retry: { max_attempts: 3, backoff_base_ms: 500 },
    compensation: [],
    jurisdiction: opts.jurisdiction ?? 'EU',
    risk_level: actions.some((a) => a.destructive) ? 'medium' : 'low',
    health_check: { action_key: readAction?.key ?? actions[0]?.key ?? 'none' },
    certification: { status: 'mapping' },
    origin: 'generated',
  };

  return { draft, warnings };
}
