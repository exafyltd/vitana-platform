/**
 * Assistant Speeches Service
 *
 * Phase 1: per-tenant overrides for the named assistant speeches in the
 * registry. Mirrors the architecture of `ai-personality-service.ts`:
 *   - Hardcoded defaults from `registry.ts`
 *   - Supabase `tenant_assistant_speeches` table for tenant overrides
 *   - 30-second in-memory cache for hot-path reads
 *   - OASIS audit events on every write
 *
 * Effective text resolution: registry default ← tenant override.
 * (No global DB layer in Phase 1 — speeches are either default or
 * tenant-overridden.)
 */
import { emitOasisEvent } from '../oasis-event-service';
import {
  SPEECH_REGISTRY,
  SPEECH_KEYS,
  SpeechKey,
  SpeechRegistryEntry,
  getRegistryEntry,
  isValidSpeechKey,
} from './registry';

// =============================================================================
// Environment
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// =============================================================================
// Types
// =============================================================================

export interface TenantSpeechOverride {
  tenant_id: string;
  speech_key: SpeechKey;
  text: string;
  updated_at: string;
  updated_by: string | null;
}

export interface SpeechDto {
  key: SpeechKey;
  label: string;
  description: string;
  journey_stage: SpeechRegistryEntry['journey_stage'];
  default_text: string;
  current_text: string;
  has_override: boolean;
  plays_prerecorded_audio?: boolean;
  updated_at?: string;
  updated_by?: string;
}

// =============================================================================
// Cache
// =============================================================================

const CACHE_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  override: TenantSpeechOverride | null;
  fetchedAt: number;
}

// Cache key: `${tenantId}:${speechKey}`
const overrideCache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, speechKey: SpeechKey): string {
  return `${tenantId}:${speechKey}`;
}

function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

export function clearSpeechCache(tenantId?: string, speechKey?: SpeechKey): void {
  if (tenantId && speechKey) {
    overrideCache.delete(cacheKey(tenantId, speechKey));
    return;
  }
  if (tenantId) {
    for (const k of Array.from(overrideCache.keys())) {
      if (k.startsWith(`${tenantId}:`)) overrideCache.delete(k);
    }
    return;
  }
  overrideCache.clear();
}

// =============================================================================
// Internal helpers
// =============================================================================

function buildDto(
  entry: SpeechRegistryEntry,
  override: TenantSpeechOverride | null
): SpeechDto {
  const dto: SpeechDto = {
    key: entry.key,
    label: entry.label,
    description: entry.description,
    journey_stage: entry.journey_stage,
    default_text: entry.default_text,
    current_text: override?.text ?? entry.default_text,
    has_override: !!override,
  };
  if (entry.plays_prerecorded_audio) {
    dto.plays_prerecorded_audio = true;
  }
  if (override) {
    dto.updated_at = override.updated_at;
    if (override.updated_by) dto.updated_by = override.updated_by;
  }
  return dto;
}

async function fetchTenantOverride(
  tenantId: string,
  speechKey: SpeechKey
): Promise<TenantSpeechOverride | null> {
  // Cache
  const cached = overrideCache.get(cacheKey(tenantId, speechKey));
  if (cached && isCacheValid(cached)) {
    return cached.override;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return null;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/tenant_assistant_speeches?tenant_id=eq.${encodeURIComponent(tenantId)}&speech_key=eq.${encodeURIComponent(speechKey)}&select=*`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }
    );

    if (!response.ok) {
      console.warn(
        `[ASSISTANT-SPEECHES] Failed to fetch override for ${tenantId}/${speechKey}: ${response.status}`
      );
      return null;
    }

    const rows = (await response.json()) as TenantSpeechOverride[];
    const override = rows.length > 0 ? rows[0] : null;
    overrideCache.set(cacheKey(tenantId, speechKey), {
      override,
      fetchedAt: Date.now(),
    });
    return override;
  } catch (error: any) {
    console.error(
      `[ASSISTANT-SPEECHES] Error fetching override for ${tenantId}/${speechKey}:`,
      error
    );
    return null;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get a single speech (default + tenant override merged) as a DTO.
 */
export async function getSpeech(
  speechKey: SpeechKey,
  tenantId: string
): Promise<SpeechDto | null> {
  const entry = getRegistryEntry(speechKey);
  if (!entry) return null;
  const override = await fetchTenantOverride(tenantId, speechKey);
  return buildDto(entry, override);
}

/**
 * List all registered speeches with effective text for the given tenant.
 */
export async function listSpeeches(tenantId: string): Promise<SpeechDto[]> {
  const results: SpeechDto[] = [];
  for (const entry of SPEECH_REGISTRY) {
    const override = await fetchTenantOverride(tenantId, entry.key);
    results.push(buildDto(entry, override));
  }
  return results;
}

/**
 * Upsert a tenant override for a speech.
 */
export async function upsertTenantSpeech(
  tenantId: string,
  speechKey: SpeechKey,
  text: string,
  updatedBy: string
): Promise<{ ok: boolean; speech?: SpeechDto; error?: string }> {
  const entry = getRegistryEntry(speechKey);
  if (!entry) return { ok: false, error: 'INVALID_SPEECH_KEY' };
  if (!text || !text.trim()) return { ok: false, error: 'EMPTY_TEXT' };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const previous = await fetchTenantOverride(tenantId, speechKey);
    const nowIso = new Date().toISOString();

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/tenant_assistant_speeches`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify({
          tenant_id: tenantId,
          speech_key: speechKey,
          text,
          updated_at: nowIso,
          updated_by: updatedBy,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[ASSISTANT-SPEECHES] Failed to upsert ${tenantId}/${speechKey}: ${response.status} - ${errorText}`
      );
      return { ok: false, error: `DB error: ${response.status}` };
    }

    // Audit
    await fetch(`${SUPABASE_URL}/rest/v1/assistant_speech_audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        speech_key: speechKey,
        from_text: previous?.text ?? entry.default_text,
        to_text: text,
        action: 'upsert',
        updated_by: updatedBy,
      }),
    }).catch((err) =>
      console.warn('[ASSISTANT-SPEECHES] Audit write failed:', err)
    );

    await emitOasisEvent({
      vtid: 'ASSISTANT-SPEECHES',
      type: 'assistant.speech.updated' as any,
      source: 'assistant-speeches-service',
      status: 'info',
      message: `Assistant speech updated for ${speechKey} in tenant ${tenantId}`,
      payload: {
        tenant_id: tenantId,
        speech_key: speechKey,
        updated_by: updatedBy,
      },
    }).catch(() => {});

    // Invalidate cache so next read sees the new override
    clearSpeechCache(tenantId, speechKey);

    const updated = await fetchTenantOverride(tenantId, speechKey);
    const speech = buildDto(entry, updated);
    console.log(
      `[ASSISTANT-SPEECHES] Updated ${speechKey} for tenant ${tenantId} by ${updatedBy}`
    );
    return { ok: true, speech };
  } catch (error: any) {
    console.error(
      `[ASSISTANT-SPEECHES] Error upserting ${tenantId}/${speechKey}:`,
      error
    );
    return { ok: false, error: error.message };
  }
}

/**
 * Reset a tenant override (delete the row). The effective text reverts
 * to the registry default. Returns the resulting effective speech DTO.
 */
export async function resetTenantSpeech(
  tenantId: string,
  speechKey: SpeechKey,
  updatedBy: string
): Promise<{ ok: boolean; speech?: SpeechDto; error?: string }> {
  const entry = getRegistryEntry(speechKey);
  if (!entry) return { ok: false, error: 'INVALID_SPEECH_KEY' };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Supabase not configured' };
  }

  try {
    const previous = await fetchTenantOverride(tenantId, speechKey);

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/tenant_assistant_speeches?tenant_id=eq.${encodeURIComponent(tenantId)}&speech_key=eq.${encodeURIComponent(speechKey)}`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[ASSISTANT-SPEECHES] Failed to reset ${tenantId}/${speechKey}: ${response.status} - ${errorText}`
      );
      return { ok: false, error: `DB error: ${response.status}` };
    }

    // Audit
    await fetch(`${SUPABASE_URL}/rest/v1/assistant_speech_audit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        speech_key: speechKey,
        from_text: previous?.text ?? entry.default_text,
        to_text: entry.default_text,
        action: 'reset',
        updated_by: updatedBy,
      }),
    }).catch((err) =>
      console.warn('[ASSISTANT-SPEECHES] Audit write failed:', err)
    );

    await emitOasisEvent({
      vtid: 'ASSISTANT-SPEECHES',
      type: 'assistant.speech.reset' as any,
      source: 'assistant-speeches-service',
      status: 'info',
      message: `Assistant speech reset to default for ${speechKey} in tenant ${tenantId}`,
      payload: {
        tenant_id: tenantId,
        speech_key: speechKey,
        updated_by: updatedBy,
      },
    }).catch(() => {});

    clearSpeechCache(tenantId, speechKey);

    // Effective is now the registry default
    const speech = buildDto(entry, null);
    console.log(
      `[ASSISTANT-SPEECHES] Reset ${speechKey} for tenant ${tenantId} by ${updatedBy}`
    );
    return { ok: true, speech };
  } catch (error: any) {
    console.error(
      `[ASSISTANT-SPEECHES] Error resetting ${tenantId}/${speechKey}:`,
      error
    );
    return { ok: false, error: error.message };
  }
}

/**
 * Runtime helper for callers that just need the effective speech text.
 * Returns the tenant override if present, otherwise the registry default.
 * Returns null if the speech key is not in the registry.
 */
export async function getEffectiveSpeechText(
  speechKey: SpeechKey,
  tenantId: string | null
): Promise<string | null> {
  const entry = getRegistryEntry(speechKey);
  if (!entry) return null;
  if (!tenantId) return entry.default_text;
  const override = await fetchTenantOverride(tenantId, speechKey);
  return override?.text ?? entry.default_text;
}

// Re-exports for convenience
export {
  SPEECH_KEYS,
  SPEECH_REGISTRY,
  isValidSpeechKey,
  getRegistryEntry,
};
export type { SpeechKey, SpeechRegistryEntry };
