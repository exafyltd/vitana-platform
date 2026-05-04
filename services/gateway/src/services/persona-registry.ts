/**
 * VTID-02651: Persona registry — runtime loader for agent_personas.
 *
 * Replaces the hardcoded SPECIALIST_VOICES + getSpecialistGreeting +
 * KIND_TO_PERSONA constants in orb-live.ts. Adding a new specialist is now
 * one INSERT into agent_personas (key, display_name, role, voice_id,
 * system_prompt, handles_kinds, handoff_keywords, greeting_templates) —
 * zero code change, zero redeploy.
 *
 * Cached in-process for 60s. Cache is per-gateway-instance, not shared
 * across replicas; that's fine because changes propagate within 60s and
 * voice swaps are not high-volume.
 */

import { createClient } from '@supabase/supabase-js';

export interface PersonaRecord {
  id: string;
  key: string;
  display_name: string;
  role: string;
  voice_id: string | null;
  system_prompt: string;
  intake_schema_ref: string | null;
  handles_kinds: string[];
  handoff_keywords: string[];
  greeting_templates: Record<string, string>;
  status: 'active' | 'draft' | 'disabled';
  version: number;
  updated_at: string | null;
}

// Special key for the receptionist persona. By convention the row keyed
// 'vitana' is the default voice channel — when no other persona is active,
// the system uses Vitana's voice (from LIVE_API_VOICES per language) and
// the standard buildLiveSystemInstruction prompt path. Hardcoded only as a
// well-known sentinel; everything else is data-driven.
export const RECEPTIONIST_KEY = 'vitana';

const CACHE_TTL_MS = 60_000;

let cache: { at: number; map: Map<string, PersonaRecord> } | null = null;
let inFlight: Promise<Map<string, PersonaRecord>> | null = null;

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    throw new Error('persona-registry: SUPABASE_URL or SUPABASE_SERVICE_ROLE missing');
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function loadFromDB(): Promise<Map<string, PersonaRecord>> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('agent_personas_registry')
    .select('*');
  if (error) {
    console.warn('[persona-registry] load failed, returning empty registry:', error.message);
    return new Map();
  }
  const map = new Map<string, PersonaRecord>();
  for (const row of data ?? []) {
    const r = row as PersonaRecord;
    map.set(r.key, r);
  }
  return map;
}

export async function loadPersonaRegistry(forceRefresh = false): Promise<Map<string, PersonaRecord>> {
  if (!forceRefresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.map;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const map = await loadFromDB();
      cache = { at: Date.now(), map };
      return map;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function clearPersonaRegistryCache(): void {
  cache = null;
}

/**
 * Returns the persona's voice_id, falling back to '' (caller decides what
 * the empty sentinel means — typically "use language default voice").
 */
export async function getPersonaVoice(key: string): Promise<string> {
  const reg = await loadPersonaRegistry();
  return reg.get(key)?.voice_id ?? '';
}

function extractLocale(langOrCtx: any): string {
  if (!langOrCtx) return 'en';
  
  if (typeof langOrCtx === 'string' && langOrCtx.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(langOrCtx);
      if (typeof parsed === 'object' && parsed !== null) {
        langOrCtx = parsed;
      }
    } catch (e) {
      // ignore, keep as string
    }
  }

  let val: any = 'en';
  if (typeof langOrCtx === 'string') {
    val = langOrCtx;
  } else if (typeof langOrCtx === 'object' && langOrCtx !== null) {
    val = langOrCtx.user?.locale 
       || langOrCtx.user?.language 
       || langOrCtx.session?.locale 
       || langOrCtx.session?.language 
       || langOrCtx.locale 
       || langOrCtx.language 
       || 'en';
  }

  if (typeof val !== 'string' || val === '[object Object]') {
    return 'en';
  }

  return val.split('-')[0].toLowerCase() || 'en';
}

/**
 * Returns the persona's greeting in the requested language, falling
 * through `lang → 'en' → generic` so a missing language never hard-fails.
 */
export async function getPersonaGreeting(key: string, lang: any): Promise<string> {
  const locale = extractLocale(lang);
  const reg = await loadPersonaRegistry();
  const p = reg.get(key);
  if (!p) return `Hi, ${key} here. How can I help?`;
  const tpls = p.greeting_templates ?? {};
  if (tpls[locale]) return tpls[locale];
  if (tpls['en']) return tpls['en'];
  // Last-resort generic — covers the "operator just inserted a new persona
  // and forgot to fill greeting_templates" case so the swap never sounds
  // broken; a default greeting is better than silence.
  return `Hi, ${p.display_name} here. How can I help?`;
}

/**
 * Resolves a feedback ticket `kind` to the persona key that handles it.
 * Looks up agent_personas.handles_kinds — the same array the keyword
 * router (pick_specialist_for_text) reads. Returns the first persona
 * whose handles_kinds contains the kind, or null if no match (caller
 * decides whether to fall back to the receptionist).
 */
export async function pickPersonaForKind(kind: string): Promise<string | null> {
  if (!kind) return null;
  const reg = await loadPersonaRegistry();
  for (const p of reg.values()) {
    if (p.key === RECEPTIONIST_KEY) continue;  // Vitana doesn't resolve claims herself
    if (Array.isArray(p.handles_kinds) && p.handles_kinds.includes(kind)) {
      return p.key;
    }
  }
  return null;
}

/**
 * Returns the list of persona keys excluding the receptionist. Useful for
 * tool descriptions, validation, and Command Hub UI.
 */
export async function listSpecialistKeys(): Promise<string[]> {
  const reg = await loadPersonaRegistry();
  return [...reg.keys()].filter(k => k !== RECEPTIONIST_KEY);
}

/**
 * Returns the full list of persona keys including the receptionist.
 * Used by switch_persona tool validation (any persona is a valid target).
 */
export async function listAllPersonaKeys(): Promise<string[]> {
  const reg = await loadPersonaRegistry();
  return [...reg.keys()];
}

/**
 * True if the key matches a known active persona.
 */
export async function isValidPersona(key: string): Promise<boolean> {
  const reg = await loadPersonaRegistry();
  return reg.has(key);
}

// ===========================================================================
// VTID-02653: Phase 6 — tenant overlay support.
// ===========================================================================
// Three-layer separation:
//   Command Hub (BUILD)    → agent_personas + agent_tools + audit_log
//   Tenant Admin (CUSTOMIZE) → agent_personas_tenant_overrides +
//                              agent_kb_bindings_tenant +
//                              agent_routing_keywords_tenant +
//                              agent_third_party_connections (tenant_id=X)
//   Community User (USE)   → loadPersonaRegistryForTenant() at runtime
//
// The tenant-aware loader merges platform defaults with the tenant's
// overrides:
//   - filter out personas where the tenant has set enabled=false
//   - merge intake_schema_extras into a shadow field on the record
//   - prefer custom_greeting_templates over platform greetings when present

export interface TenantOverridesRecord {
  tenant_id: string;
  persona_id: string;
  enabled: boolean;
  intake_schema_extras: Record<string, unknown>;
  custom_greeting_templates: Record<string, string>;
}

export interface TenantPersonaRecord extends PersonaRecord {
  // Effective record after applying tenant overlay. Always has
  // tenant_enabled (defaults to true if no override row exists).
  tenant_enabled: boolean;
  intake_schema_extras: Record<string, unknown>;
}

const tenantCache = new Map<string, { at: number; map: Map<string, TenantPersonaRecord> }>();

async function loadTenantOverrides(tenantId: string): Promise<Map<string, TenantOverridesRecord>> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('agent_personas_tenant_overrides')
    .select('tenant_id, persona_id, enabled, intake_schema_extras, custom_greeting_templates')
    .eq('tenant_id', tenantId);
  if (error) {
    console.warn(`[persona-registry] tenant overrides load failed for ${tenantId}:`, error.message);
    return new Map();
  }
  const map = new Map<string, TenantOverridesRecord>();
  for (const row of data ?? []) {
    const r = row as TenantOverridesRecord;
    map.set(r.persona_id, r);
  }
  return map;
}

/**
 * Tenant-aware variant of loadPersonaRegistry. Merges platform defaults
 * with the tenant's overlay rows. Cached for 60s per tenant.
 */
export async function loadPersonaRegistryForTenant(
  tenantId: string,
  forceRefresh = false,
): Promise<Map<string, TenantPersonaRecord>> {
  if (!tenantId) {
    // No tenant → return platform-only view, with tenant_enabled=true on all.
    const platform = await loadPersonaRegistry(forceRefresh);
    const merged = new Map<string, TenantPersonaRecord>();
    for (const [k, p] of platform) {
      merged.set(k, { ...p, tenant_enabled: true, intake_schema_extras: {} });
    }
    return merged;
  }
  const cached = tenantCache.get(tenantId);
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.map;
  }
  const [platform, overrides] = await Promise.all([
    loadPersonaRegistry(forceRefresh),
    loadTenantOverrides(tenantId),
  ]);
  const merged = new Map<string, TenantPersonaRecord>();
  for (const [k, p] of platform) {
    const ov = overrides.get(p.id);
    const tenant_enabled = ov ? ov.enabled : true;
    // Merge greeting templates: tenant custom wins over platform per-language
    const greeting_templates =
      ov?.custom_greeting_templates && Object.keys(ov.custom_greeting_templates).length > 0
        ? { ...p.greeting_templates, ...ov.custom_greeting_templates }
        : p.greeting_templates;
    merged.set(k, {
      ...p,
      greeting_templates,
      tenant_enabled,
      intake_schema_extras: ov?.intake_schema_extras ?? {},
    });
  }
  tenantCache.set(tenantId, { at: Date.now(), map: merged });
  return merged;
}

export function clearTenantPersonaCache(tenantId?: string): void {
  if (tenantId) tenantCache.delete(tenantId);
  else tenantCache.clear();
}

/**
 * Tenant-aware voice lookup. If the tenant disabled this persona (or the
 * persona doesn't exist), returns ''. Custom voice overrides are NOT yet
 * supported on the tenant overlay (deferred per Phase 6 plan); this just
 * gates by tenant_enabled.
 */
export async function getPersonaVoiceForTenant(key: string, tenantId: string): Promise<string> {
  const reg = await loadPersonaRegistryForTenant(tenantId);
  const p = reg.get(key);
  if (!p || !p.tenant_enabled) return '';
  return p.voice_id ?? '';
}

/**
 * Tenant-aware greeting lookup. Honors tenant custom_greeting_templates
 * if set, otherwise falls back to platform greeting → English → generic.
 */
export async function getPersonaGreetingForTenant(
  key: string,
  lang: any,
  tenantId: string,
): Promise<string> {
  const locale = extractLocale(lang);
  const reg = await loadPersonaRegistryForTenant(tenantId);
  const p = reg.get(key);
  if (!p) return `Hi, ${key} here. How can I help?`;
  const tpls = p.greeting_templates ?? {};
  if (tpls[locale]) return tpls[locale];
  if (tpls['en']) return tpls['en'];
  return `Hi, ${p.display_name} here. How can I help?`;
}

/**
 * Tenant-aware kind→persona resolver. Same shape as pickPersonaForKind
 * but skips personas the tenant has disabled.
 */
export async function pickPersonaForKindForTenant(
  kind: string,
  tenantId: string,
): Promise<string | null> {
  if (!kind) return null;
  const reg = await loadPersonaRegistryForTenant(tenantId);
  for (const p of reg.values()) {
    if (p.key === RECEPTIONIST_KEY) continue;
    if (!p.tenant_enabled) continue;
    if (Array.isArray(p.handles_kinds) && p.handles_kinds.includes(kind)) {
      return p.key;
    }
  }
  return null;
}

/**
 * Tenant-aware persona validity. Returns false if the persona doesn't
 * exist or is disabled for this tenant. Used by switch_persona to prevent
 * the LLM from switching the user to a colleague their tenant disabled.
 */
export async function isValidPersonaForTenant(key: string, tenantId: string): Promise<boolean> {
  const reg = await loadPersonaRegistryForTenant(tenantId);
  const p = reg.get(key);
  return !!p && p.tenant_enabled;
}

/**
 * Tenant-aware persona keys list. Returns only personas enabled for the
 * tenant. Used by switch_persona error messages and the runtime tool
 * description hints.
 */
export async function listAllPersonaKeysForTenant(tenantId: string): Promise<string[]> {
  const reg = await loadPersonaRegistryForTenant(tenantId);
  const out: string[] = [];
  for (const [k, p] of reg) {
    if (p.tenant_enabled) out.push(k);
  }
  return out;
}