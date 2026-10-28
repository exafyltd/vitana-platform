/**
 * ConnectorManifest — the versioned, declarative description a connector is
 * compiled FROM (Commerce Mesh brief Sec. 4, ADR-002).
 *
 * Hard rules enforced here:
 *  - Secrets appear ONLY as vault references (`vault:` / `secret:` /
 *    `projects/…/secrets/…`). Anything value-shaped in an auth/secret field
 *    fails validation — same discipline as the no-credential-store guardrail.
 *  - Cross-references must resolve (mappings → declared schemas, human-gated
 *    actions → declared actions, compensation → declared actions).
 *  - A manifest version is immutable once certified; activation requires
 *    certification (certification.ts), never a flag edit.
 */
import { z } from 'zod';
import { CANONICAL_ENTITY_TYPES } from '../canonical/model';

export const CONNECTION_TYPES = [
  'mcp',
  'openapi',
  'oauth_api',
  'rest',
  'graphql',
  'webhook',
  'platform_install',
  'scim',
  'edi_sftp',
  'browser',
  'manual',
] as const;

export const CONNECTION_STATES = [
  'discovered',
  'authorization_required',
  'mapping',
  'testing',
  'approval_required',
  'certified',
  'active',
  'degraded',
  'suspended',
  'revoked',
  'failed',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Legal state transitions (Partner Portal + healing both consult this). */
export const STATE_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
  discovered: ['authorization_required', 'mapping', 'failed', 'revoked'],
  authorization_required: ['mapping', 'failed', 'revoked'],
  mapping: ['testing', 'failed', 'revoked'],
  testing: ['approval_required', 'certified', 'failed', 'revoked'],
  approval_required: ['certified', 'mapping', 'failed', 'revoked'],
  certified: ['active', 'revoked'],
  active: ['degraded', 'suspended', 'revoked'],
  degraded: ['active', 'suspended', 'failed', 'revoked'],
  suspended: ['active', 'revoked'],
  revoked: [],
  failed: ['mapping', 'revoked'],
};

const SECRET_REF_PATTERN = /^(vault:|secret:|projects\/[^\s]+\/secrets\/)/;
/** Value-shaped strings that must never appear where a secret ref belongs. */
const SECRET_VALUE_PATTERN = /^(sk|pk|ghp|xox|AKIA|SBX|PRD)[-_A-Za-z0-9]{8,}|.{40,}$/;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'kebab-case slug required');
const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'semver required');

const FieldSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    required: z.boolean().default(false),
    sensitive: z.boolean().default(false),
  })
  .strict();
export type ManifestField = z.infer<typeof FieldSchema>;

const SourceSchemaSchema = z
  .object({
    name: z.string().min(1),
    fields: z.array(FieldSchema),
    /** Content hash of the raw partner schema this was extracted from (drift detection). */
    hash: z.string().min(8),
  })
  .strict();

const MappingSchema = z
  .object({
    source_schema: z.string(),
    source_field: z.string(),
    canonical_entity: z.enum(CANONICAL_ENTITY_TYPES),
    canonical_field: z.string(),
    /** Optional named transform (e.g. 'cents_to_decimal') — resolved by the factory. */
    transform: z.string().optional(),
    confidence: z.number().min(0).max(1),
    decided_by: z.enum(['ai', 'human']),
    sensitive: z.boolean().default(false),
  })
  .strict();
export type ManifestMapping = z.infer<typeof MappingSchema>;

const ActionSchema = z
  .object({
    key: z.string().min(1),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(1),
    kind: z.enum(['read', 'action']),
    destructive: z.boolean().default(false),
    human_gated: z.boolean().default(false),
    idempotency: z.enum(['none', 'idempotency_key']).default('none'),
    input_schema: z.string().optional(),
    output_schema: z.string().optional(),
  })
  .strict();
export type ManifestAction = z.infer<typeof ActionSchema>;

export const ConnectorManifestSchema = z
  .object({
    connector_id: slug,
    version: semver,
    partner_tenant_id: z.string().min(1),
    /** Provider id in the VCAOP policy engine — the policy row that gates every call. */
    provider_id: z.string().min(1),
    connection_type: z.enum(CONNECTION_TYPES),
    auth: z
      .object({
        mechanism: z.enum([
          'oauth2_authorization_code',
          'oauth2_client_credentials',
          'api_key',
          'basic',
          'none',
        ]),
        /** Vault REFERENCES only — never values. */
        secret_refs: z.array(z.string().regex(SECRET_REF_PATTERN, 'must be a vault reference')),
        scopes: z.array(z.string()).default([]),
      })
      .strict(),
    capabilities: z
      .array(
        z.object({ key: z.string(), kind: z.enum(['read', 'action', 'event']), description: z.string() }).strict(),
      )
      .min(1),
    source_schemas: z.array(SourceSchemaSchema),
    canonical_mappings: z.array(MappingSchema),
    actions: z.array(ActionSchema).min(1),
    events: z
      .array(
        z
          .object({
            key: z.string(),
            source: z.enum(['webhook', 'poll']),
            schema: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    webhook_config: z
      .object({
        path: z.string(),
        signature_header: z.string(),
        secret_ref: z.string().regex(SECRET_REF_PATTERN, 'must be a vault reference'),
      })
      .strict()
      .optional(),
    rate_limits: z.object({ requests_per_minute: z.number().int().positive() }).strict(),
    timeouts: z
      .object({
        request_ms: z.number().int().positive().max(15 * 60 * 1000),
        job_ms: z.number().int().positive().max(2 * 60 * 60 * 1000),
      })
      .strict(),
    retry: z
      .object({
        max_attempts: z.number().int().min(1).max(10),
        backoff_base_ms: z.number().int().positive(),
      })
      .strict(),
    compensation: z
      .array(z.object({ action_key: z.string(), compensating_action_key: z.string() }).strict())
      .default([]),
    jurisdiction: z.string().min(2).max(8),
    risk_level: z.enum(['low', 'medium', 'high']),
    health_check: z.object({ action_key: z.string() }).strict(),
    certification: z
      .object({
        status: z.enum(CONNECTION_STATES),
        certified_at: z.string().optional(),
        certified_by: z.string().optional(),
      })
      .strict(),
    origin: z.enum(['generated', 'handwritten']).default('generated'),
  })
  .strict();

export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

export interface ManifestValidationResult {
  ok: boolean;
  manifest?: ConnectorManifest;
  errors: string[];
}

/** Walks every string in the manifest hunting for secret-shaped VALUES (defense in depth). */
function findInlineSecrets(obj: unknown, path: string, errors: string[]): void {
  if (typeof obj === 'string') {
    // A ref-shaped string is fine anywhere; a value-shaped one is fine only
    // when it is clearly not a credential context — we reject conservatively
    // in auth/webhook contexts (handled below via schema) and long opaque
    // strings in *_ref-named fields.
    return;
  }
  if (obj === null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (
      /(secret|credential|password|token|api_key)/i.test(k) &&
      typeof v === 'string' &&
      !SECRET_REF_PATTERN.test(v)
    ) {
      errors.push(`Inline secret-shaped value at ${path}.${k} — store a vault reference instead`);
    }
    if (typeof v === 'string' && /_ref$/.test(k) && SECRET_VALUE_PATTERN.test(v) && !SECRET_REF_PATTERN.test(v)) {
      errors.push(`Field ${path}.${k} looks like a raw credential, not a reference`);
    }
    findInlineSecrets(v, `${path}.${k}`, errors);
  }
}

export function validateManifest(input: unknown): ManifestValidationResult {
  const errors: string[] = [];
  const parsed = ConnectorManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const m = parsed.data;

  findInlineSecrets(input, 'manifest', errors);

  const schemaNames = new Set(m.source_schemas.map((s) => s.name));
  for (const mp of m.canonical_mappings) {
    if (!schemaNames.has(mp.source_schema)) {
      errors.push(`Mapping references undeclared source schema '${mp.source_schema}'`);
    }
  }
  const actionKeys = new Set(m.actions.map((a) => a.key));
  for (const a of m.actions) {
    if (a.input_schema && !schemaNames.has(a.input_schema)) {
      errors.push(`Action '${a.key}' references undeclared input schema '${a.input_schema}'`);
    }
    if (a.output_schema && !schemaNames.has(a.output_schema)) {
      errors.push(`Action '${a.key}' references undeclared output schema '${a.output_schema}'`);
    }
    if (a.destructive && !a.human_gated && a.idempotency === 'none') {
      errors.push(`Destructive action '${a.key}' must be human_gated or carry idempotency_key`);
    }
  }
  for (const c of m.compensation) {
    if (!actionKeys.has(c.action_key) || !actionKeys.has(c.compensating_action_key)) {
      errors.push(`Compensation pair ${c.action_key}→${c.compensating_action_key} references unknown action`);
    }
  }
  if (!actionKeys.has(m.health_check.action_key)) {
    errors.push(`health_check.action_key '${m.health_check.action_key}' is not a declared action`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, manifest: m, errors: [] };
}

export function assertTransition(from: ConnectionState, to: ConnectionState): void {
  if (!STATE_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Illegal connection state transition ${from} → ${to}`);
  }
}
