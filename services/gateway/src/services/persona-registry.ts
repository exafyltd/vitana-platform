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

/**
 * Returns the persona's greeting in the requested language, falling
 * through `lang → 'en' → generic` so a missing language never hard-fails.
 */
export async function getPersonaGreeting(key: string, lang: string): Promise<string> {
  const reg = await loadPersonaRegistry();
  const p = reg.get(key);
  if (!p) return `Hi, ${key} here. How can I help?`;
  const tpls = p.greeting_templates ?? {};
  if (tpls[lang]) return tpls[lang];
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
