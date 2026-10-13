/**
 * VTID-05150: request schemas for tenant provisioning (routes/admin-tenants.ts,
 * exafy_admin only).
 *
 *   ProvisionTenantSchema       POST  /api/v1/admin/tenants
 *   TenantBrandPackPatchSchema  PATCH /api/v1/admin/tenants/:id
 *
 * Both are strict: an unknown key (e.g. `slug` in a PATCH) is a 400.
 * persona_facts are FACTS only (CLAUDE.md rule 41): short strings, short lists,
 * never a sentence Vitana speaks — the WS5 consumer frames them inside an
 * English intent block.
 */
import { z } from 'zod';
import { JEV_PLANES } from '../jev/jev-access';

/**
 * Upper bound for a tenant's Jev monthly budget. One value for every write path
 * (provisioning and the tenant-admin settings PUT), so an exafy_admin settings
 * update can never authorise more spend than provisioning permits.
 */
export const JEV_MONTHLY_BUDGET_MAX_USD = 500;

/** Full shape of the governed `feature_flags.jev` key (jev-policy.ts parses the same fields). */
export const GovernedJevFlagSchema = z
  .object({
    enabled: z.boolean(),
    planes: z.array(z.enum(JEV_PLANES)).max(JEV_PLANES.length),
    monthly_budget_usd: z.number().finite().min(0).max(JEV_MONTHLY_BUDGET_MAX_USD).nullable(),
  })
  .strict();

export const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const LOCALE = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'locale code');

const fact = z.string().trim().min(1).max(200);
const factList = z.array(fact).max(8);

export const PersonaFactsSchema = z
  .object({
    community_name: fact.optional(),
    community_pronunciation: fact.optional(),
    anchor_person: z
      .object({ name: fact, pronunciation: fact.optional(), role: fact.optional() })
      .strict()
      .optional(),
    story_facts: factList.optional(),
    offer_facts: factList.optional(),
    tone: factList.optional(),
  })
  .strict();

// Asset paths are set by the asset route only (PUT /:id/assets/:kind), never by a PATCH.
export const BrandSchema = z
  .object({
    colors: z
      .object({ accent: z.string().regex(HEX_COLOR), bg: z.string().regex(HEX_COLOR), fg: z.string().regex(HEX_COLOR) })
      .strict()
      .optional(),
    tokens: z.record(z.string().max(40), z.union([z.string().max(80), z.number()])).optional(),
  })
  .strict();

export const LandingSchema = z
  .object({ cta: z.enum(['invite_only', 'signup', 'waitlist']).optional() })
  .strict();

const email = z.string().trim().max(254).regex(EMAIL_RE, 'email');
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 currency, upper case');
const timezone = z.string().min(1).max(64);

export const ProvisionTenantSchema = z
  .object({
    slug: z.string().min(3).max(32).regex(SLUG_RE, 'lowercase letters/digits, single hyphens, starts with a letter'),
    name: z.string().trim().min(1).max(80),
    admin_email: email,
    all_members_group_name: z.string().trim().min(1).max(80),
    display_name: z.string().trim().min(1).max(80).optional(),
    jev_monthly_budget_usd: z.number().min(0).max(JEV_MONTHLY_BUDGET_MAX_USD).optional(),
    default_locale: LOCALE.optional(),
    enabled_locales: z.array(LOCALE).min(1).max(20).optional(),
    timezone: timezone.optional(),
    currency: currency.optional(),
  })
  .strict();
export type ProvisionTenantInput = z.infer<typeof ProvisionTenantSchema>;

export const TenantBrandPackPatchSchema = z
  .object({
    display_name: z.string().trim().min(1).max(80).optional(),
    brand: BrandSchema.optional(),
    legal_entity_line: z.string().trim().min(1).max(200).optional(),
    support_email: email.optional(),
    sender_name: z.string().trim().min(1).max(80).optional(),
    sender_email: email.optional(),
    default_locale: LOCALE.optional(),
    enabled_locales: z.array(LOCALE).min(1).max(20).optional(),
    timezone: timezone.optional(),
    currency: currency.optional(),
    landing: LandingSchema.optional(),
    persona_facts: PersonaFactsSchema.optional(),
    open_signup: z.boolean().optional(),
    override_reason: z.string().trim().min(10).max(500).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).some((k) => k !== 'override_reason'), { message: 'nothing to update' });
export type TenantBrandPackPatch = z.infer<typeof TenantBrandPackPatchSchema>;

export const ASSET_KINDS = ['logo', 'favicon', 'og_image'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
