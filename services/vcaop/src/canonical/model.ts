/**
 * Canonical Commerce & Data Graph — v1 core (Commerce Mesh, ADR-003).
 *
 * Every partner maps ONCE to this model; partner↔partner exchange is always
 * canonical-mediated. This file is the single source of truth for entity
 * names, the record envelope, and the per-entity field dictionaries the
 * mapping engine scores against. Persisted state lives in the additive
 * Prisma models (schema_source / schema_mapping / …); read-models such as
 * `cart_order` remain authoritative — canonical records reference them.
 *
 * Versioning: additive change = minor bump (normalizer up-converts);
 * breaking change = new major with a dual-write window.
 */
import { z } from 'zod';

export const CANONICAL_SCHEMA_VERSION = '1.0.0';

export type DataClassification =
  | 'public'
  | 'commercial'
  | 'personal'
  | 'sensitive'
  | 'health';

export const CANONICAL_ENTITY_TYPES = [
  'business',
  'user_identity',
  'delegated_identity',
  'product',
  'service',
  'offer',
  'pricing',
  'inventory',
  'customer',
  'consent',
  'data_grant',
  'health_data_attestation',
  'insurance_quote',
  'insurance_policy',
  'cart',
  'checkout_session',
  'order',
  'payment',
  'invoice',
  'fulfilment',
  'shipment',
  'return',
  'refund',
  'affiliate_attribution',
  'commission',
  'reward',
  'vtna_settlement',
  'audit_event',
] as const;

export type CanonicalEntityType = (typeof CANONICAL_ENTITY_TYPES)[number];

/** Entities that carry health classification — separate storage + access policy, Phase 7 only. */
export const HEALTH_CLASSIFIED_ENTITIES: CanonicalEntityType[] = [
  'health_data_attestation',
  'insurance_quote',
  'insurance_policy',
];

/** Common envelope on every canonical record (ADR-003). */
export const CanonicalEnvelopeSchema = z
  .object({
    schema_version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver required'),
    tenant_id: z.string().min(1),
    entity_type: z.enum(CANONICAL_ENTITY_TYPES),
    entity_id: z.string().min(1),
    source_connector_id: z.string().min(1),
    source_native_id: z.string().min(1),
    provenance: z.object({
      manifest_version: z.string(),
      mapping_version: z.string(),
      ingested_at: z.string(),
    }),
    jurisdiction: z.string().min(2).max(8),
    data_classification: z.enum(['public', 'commercial', 'personal', 'sensitive', 'health']),
    mapping_confidence: z.number().min(0).max(1),
    valid_from: z.string().optional(),
    valid_to: z.string().optional(),
  })
  .strict();

export type CanonicalEnvelope = z.infer<typeof CanonicalEnvelopeSchema>;

/**
 * Field dictionaries the AI mapping engine scores partner fields against.
 * Deliberately flat snake_case names — mapping targets, not storage shapes.
 */
export const CANONICAL_FIELDS: Partial<Record<CanonicalEntityType, string[]>> = {
  product: [
    'id',
    'title',
    'description',
    'merchant',
    'category',
    'sku',
    'price_amount',
    'price_currency',
    'url',
    'image_url',
  ],
  offer: ['product_id', 'merchant', 'price_amount', 'price_currency', 'rewards_enabled', 'network'],
  inventory: ['product_id', 'quantity', 'status', 'location'],
  order: [
    'id',
    'status',
    'total_amount',
    'currency',
    'created_at',
    'customer_ref',
    'line_items',
    'merchant',
  ],
  customer: ['id', 'display_name', 'email', 'phone', 'address', 'country'],
  shipment: ['order_id', 'carrier', 'tracking_ref', 'status', 'shipped_at'],
  invoice: ['order_id', 'number', 'total_amount', 'currency', 'issued_at'],
};

/**
 * Field-name keywords that force sensitive/personal classification on a
 * proposed mapping — these can never auto-certify (certification.ts).
 */
export const SENSITIVE_FIELD_PATTERN =
  /(email|phone|address|birth|dob|ssn|tax|passport|iban|bank|health|medical|weight|heart|blood)/i;

export function classifyFieldName(name: string): DataClassification {
  if (/(health|medical|weight|heart|blood|diagnosis)/i.test(name)) return 'health';
  if (SENSITIVE_FIELD_PATTERN.test(name)) return 'personal';
  return 'commercial';
}
