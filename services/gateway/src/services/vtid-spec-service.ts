/**
 * VTID-01190: VTID Spec Service
 *
 * Provides persistent, immutable VTID specification storage and retrieval.
 * This service replaces in-memory spec maps with DB-backed persistence.
 *
 * HARD GOVERNANCE RULES:
 * 1. No VTID may execute without a persisted spec
 * 2. Spec snapshot is immutable after lock
 * 3. Autopilot, Validator, Verification must read from DB
 * 4. Checksum mismatch → hard fail
 * 5. RLS enforced by tenant
 *
 * Key features:
 * - Automatic SHA-256 checksum generation
 * - Immutability enforcement via DB triggers
 * - Caching with TTL for performance
 * - OASIS event emission for spec lifecycle
 */

import { createHash, randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Environment Configuration
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Default tenant for single-tenant mode
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'default';

// Cache configuration (specs are immutable, so longer TTL is safe)
const CACHE_TTL_MS = 60_000; // 60 seconds

// =============================================================================
// Types
// =============================================================================

/**
 * Persisted VTID spec record (matches vtid_specs table)
 */
export interface VtidSpec {
  vtid: string;
  tenant_id: string;
  spec_version: number;
  spec_content: VtidSpecContent;
  spec_checksum: string;
  primary_domain: string;
  system_surface: string[];
  created_at: string;
  locked_at: string;
  created_by: string;
  metadata?: Record<string, unknown>;
}

/**
 * VTID spec content structure (stored as JSONB)
 * This is the execution contract - NOT documentation
 */
export interface VtidSpecContent {
  // Core identification
  vtid: string;
  title: string;

  // Full spec text (raw markdown/text)
  spec_text: string;

  // Extracted/computed fields
  task_domain?: string;
  target_paths?: string[];

  // Governance metadata
  layer?: string;           // e.g., 'SYSTEM', 'DEV', 'FRONTEND'
  module?: string;          // e.g., 'AUTOPILOT', 'GOVERNANCE', 'MEMORY'
  execution_mode?: string;  // e.g., 'Autonomous', 'Supervised'
  creativity?: string;      // e.g., 'FORBIDDEN', 'ALLOWED', 'REQUIRED'
  depends_on?: string[];    // VTID dependencies

  // Acceptance criteria (parsed from spec)
  acceptance_criteria?: string[];

  // Original snapshot timestamp
  snapshot_created_at: string;
}

/**
 * Request to create a spec
 */
export interface CreateSpecRequest {
  vtid: string;
  title: string;
  spec_text: string;
  task_domain?: string;
  target_paths?: string[];
  primary_domain: string;
  system_surface?: string[];
  layer?: string;
  module?: string;
  execution_mode?: string;
  creativity?: string;
  depends_on?: string[];
  acceptance_criteria?: string[];
  created_by: string;
  tenant_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Result of spec operations
 */
export interface SpecOperationResult {
  ok: boolean;
  spec?: VtidSpec;
  error?: string;
  error_code?: string;
}

/**
 * Checksum verification result
 */
export interface ChecksumVerificationResult {
  vtid: string;
  valid: boolean;
  stored_checksum: string | null;
  computed_checksum: string | null;
  locked_at: string | null;
}

// =============================================================================
// In-Memory Cache (specs are immutable, so caching is safe)
// =============================================================================

interface CacheEntry {
  spec: VtidSpec;
  fetchedAt: number;
}

const specsCache = new Map<string, CacheEntry>();

/**
 * Clear cache for a specific VTID or all VTIDs
 */
export function clearSpecsCache(vtid?: string): void {
  if (vtid) {
    specsCache.delete(vtid);
  } else {
    specsCache.clear();
  }
}

/**
 * Check if a cached entry is still valid
 */
function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

// =============================================================================
// Checksum Utilities
// =============================================================================

/**
 * Compute SHA-256 checksum of spec content
 */
export function computeSpecChecksum(specContent: VtidSpecContent): string {
  const contentString = JSON.stringify(specContent);
  return createHash('sha256').update(contentString).digest('hex');
}

/**
 * Verify a spec's checksum matches its content
 */
export function verifyChecksumLocally(spec: VtidSpec): boolean {
  const computedChecksum = computeSpecChecksum(spec.spec_content);
  return computedChecksum === spec.spec_checksum;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Create a new VTID spec (immutable after creation)
 *
 * This is the ONLY way to create specs. The spec is locked immediately
 * upon creation - no edits allowed.
 */
export async function createVtidSpec(request: CreateSpecRequest): Promise<SpecOperationResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error('[VTID-01190] Missing Supabase config, cannot create spec');
    return { ok: false, error: 'Gateway misconfigured: missing Supabase credentials', error_code: 'CONFIG_ERROR' };
  }

  // Validate required fields
  if (!request.vtid || request.vtid.trim() === '') {
    return { ok: false, error: 'VTID is required', error_code: 'VALIDATION_ERROR' };
  }
  if (!request.title || request.title.trim() === '') {
    return { ok: false, error: 'Title is required', error_code: 'VALIDATION_ERROR' };
  }
  if (!request.spec_text || request.spec_text.trim() === '') {
    return { ok: false, error: 'Spec text is required', error_code: 'VALIDATION_ERROR' };
  }
  if (!request.primary_domain || request.primary_domain.trim() === '') {
    return { ok: false, error: 'Primary domain is required', error_code: 'VALIDATION_ERROR' };
  }
  if (!request.created_by || request.created_by.trim() === '') {
    return { ok: false, error: 'Created by is required', error_code: 'VALIDATION_ERROR' };
  }

  // Build spec content
  const specContent: VtidSpecContent = {
    vtid: request.vtid,
    title: request.title,
    spec_text: request.spec_text,
    task_domain: request.task_domain,
    target_paths: request.target_paths,
    layer: request.layer,
    module: request.module,
    execution_mode: request.execution_mode,
    creativity: request.creativity,
    depends_on: request.depends_on,
    acceptance_criteria: request.acceptance_criteria,
    snapshot_created_at: new Date().toISOString(),
  };

  // Compute checksum
  const checksum = computeSpecChecksum(specContent);

  // Prepare DB record
  const tenantId = request.tenant_id || DEFAULT_TENANT_ID;
  const systemSurface = request.system_surface || [];

  try {
    // Check if spec already exists (idempotent - return existing)
    const existingSpec = await getVtidSpec(request.vtid, { verifyChecksum: false, bypassCache: true });
    if (existingSpec) {
      console.log(`[VTID-01190] Spec already exists for ${request.vtid}, returning existing`);
      return { ok: true, spec: existingSpec };
    }

    // Insert new spec
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_specs`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          vtid: request.vtid,
          tenant_id: tenantId,
          spec_version: 1,
          spec_content: specContent,
          spec_checksum: checksum,
          primary_domain: request.primary_domain,
          system_surface: systemSurface,
          created_at: new Date().toISOString(),
          locked_at: new Date().toISOString(), // Lock immediately
          created_by: request.created_by,
          metadata: request.metadata || {},
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      // Check if it's a duplicate key error (race condition - spec created between check and insert)
      if (response.status === 409 || errorText.includes('duplicate key')) {
        const existingSpec = await getVtidSpec(request.vtid, { verifyChecksum: false });
        if (existingSpec) {
          console.log(`[VTID-01190] Spec created by concurrent request for ${request.vtid}, returning existing`);
          return { ok: true, spec: existingSpec };
        }
      }

      console.error(`[VTID-01190] Failed to create spec for ${request.vtid}: ${response.status} - ${errorText}`);
      return { ok: false, error: `Database insert failed: ${response.status}`, error_code: 'DB_ERROR' };
    }

    const rows = (await response.json()) as VtidSpec[];
    const savedSpec = rows[0];

    // Update cache
    specsCache.set(request.vtid, { spec: savedSpec, fetchedAt: Date.now() });

    // Emit OASIS event
    await emitOasisEvent({
      vtid: request.vtid,
      type: 'autopilot.spec.created' as any,
      source: 'vtid-spec-service',
      status: 'info',
      message: `VTID spec created and locked for ${request.vtid}`,
      payload: {
        vtid: request.vtid,
        tenant_id: tenantId,
        primary_domain: request.primary_domain,
        system_surface: systemSurface,
        checksum: checksum,
        spec_length: request.spec_text.length,
        created_by: request.created_by,
        locked_at: savedSpec.locked_at,
      },
    });

    console.log(`[VTID-01190] Created and locked spec for ${request.vtid} (checksum: ${checksum.slice(0, 8)}...)`);

    return { ok: true, spec: savedSpec };
  } catch (error) {
    console.error(`[VTID-01190] Error creating spec for ${request.vtid}:`, error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      error_code: 'INTERNAL_ERROR'
    };
  }
}

/**
 * Get a VTID spec by VTID
 *
 * Options:
 * - verifyChecksum: Verify integrity before returning (default: true)
 * - bypassCache: Skip cache and fetch from DB (default: false)
 *
 * Returns null if spec doesn't exist or checksum verification fails.
 */
export async function getVtidSpec(
  vtid: string,
  options: { verifyChecksum?: boolean; bypassCache?: boolean } = {}
): Promise<VtidSpec | null> {
  const { verifyChecksum = true, bypassCache = false } = options;

  // Check cache first (unless bypassed)
  if (!bypassCache) {
    const cached = specsCache.get(vtid);
    if (cached && isCacheValid(cached)) {
      // Verify checksum if requested
      if (verifyChecksum && !verifyChecksumLocally(cached.spec)) {
        console.error(`[VTID-01190] CHECKSUM MISMATCH for cached spec ${vtid} - HARD FAIL`);
        await emitChecksumFailureEvent(vtid, 'cache');
        return null;
      }
      return cached.spec;
    }
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-01190] Missing Supabase config, cannot fetch spec');
    return null;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_specs?vtid=eq.${encodeURIComponent(vtid)}`,
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
      const errorText = await response.text();
      console.error(`[VTID-01190] Failed to fetch spec for ${vtid}: ${response.status} - ${errorText}`);
      return null;
    }

    const rows = (await response.json()) as VtidSpec[];
    if (rows.length === 0) {
      return null;
    }

    const spec = rows[0];

    // Verify checksum if requested
    if (verifyChecksum && !verifyChecksumLocally(spec)) {
      console.error(`[VTID-01190] CHECKSUM MISMATCH for spec ${vtid} - HARD FAIL`);
      await emitChecksumFailureEvent(vtid, 'database');
      return null;
    }

    // Update cache
    specsCache.set(vtid, { spec, fetchedAt: Date.now() });

    return spec;
  } catch (error) {
    console.error(`[VTID-01190] Error fetching spec for ${vtid}:`, error);
    return null;
  }
}

/**
 * Check if a VTID spec exists
 *
 * This is a lightweight check that doesn't load the full spec.
 */
export async function vtidSpecExists(vtid: string): Promise<boolean> {
  // Check cache first
  const cached = specsCache.get(vtid);
  if (cached && isCacheValid(cached)) {
    return true;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-01190] Missing Supabase config, cannot check spec existence');
    return false;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/vtid_specs?vtid=eq.${encodeURIComponent(vtid)}&select=vtid`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'count=exact',
        },
      }
    );

    if (!response.ok) {
      console.error(`[VTID-01190] Failed to check spec existence for ${vtid}: ${response.status}`);
      return false;
    }

    const rows = (await response.json()) as { vtid: string }[];
    return rows.length > 0;
  } catch (error) {
    console.error(`[VTID-01190] Error checking spec existence for ${vtid}:`, error);
    return false;
  }
}

/**
 * Verify spec checksum in database
 *
 * This uses the DB function for authoritative verification.
 */
export async function verifySpecChecksum(vtid: string): Promise<ChecksumVerificationResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return {
      vtid,
      valid: false,
      stored_checksum: null,
      computed_checksum: null,
      locked_at: null,
    };
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/verify_vtid_spec_checksum`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
        body: JSON.stringify({ p_vtid: vtid }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[VTID-01190] Failed to verify checksum for ${vtid}: ${response.status} - ${errorText}`);
      return {
        vtid,
        valid: false,
        stored_checksum: null,
        computed_checksum: null,
        locked_at: null,
      };
    }

    const rows = (await response.json()) as ChecksumVerificationResult[];
    if (rows.length === 0) {
      return {
        vtid,
        valid: false,
        stored_checksum: null,
        computed_checksum: null,
        locked_at: null,
      };
    }

    return rows[0];
  } catch (error) {
    console.error(`[VTID-01190] Error verifying checksum for ${vtid}:`, error);
    return {
      vtid,
      valid: false,
      stored_checksum: null,
      computed_checksum: null,
      locked_at: null,
    };
  }
}

// =============================================================================
// Enforcement Functions
// =============================================================================

/**
 * HARD ENFORCEMENT: Check if a VTID can enter execution
 *
 * Returns an error if:
 * - Spec doesn't exist (SPEC_NOT_FOUND)
 * - Checksum verification fails (CHECKSUM_MISMATCH)
 * - Spec is not locked (SPEC_NOT_LOCKED)
 */
export async function enforceSpecRequirement(vtid: string): Promise<{
  allowed: boolean;
  spec?: VtidSpec;
  error?: string;
  error_code?: string;
}> {
  // Get spec with checksum verification
  const spec = await getVtidSpec(vtid, { verifyChecksum: true });

  if (!spec) {
    // Check if spec exists but checksum failed
    const exists = await vtidSpecExists(vtid);
    if (exists) {
      console.error(`[VTID-01190] ENFORCEMENT BLOCK: Spec exists but checksum invalid for ${vtid}`);
      return {
        allowed: false,
        error: `Spec checksum verification failed for ${vtid}`,
        error_code: 'CHECKSUM_MISMATCH',
      };
    }

    console.error(`[VTID-01190] ENFORCEMENT BLOCK: No spec found for ${vtid}`);
    return {
      allowed: false,
      error: `No persisted spec found for ${vtid} - VTID cannot execute without spec`,
      error_code: 'SPEC_NOT_FOUND',
    };
  }

  // Verify spec is locked
  if (!spec.locked_at) {
    console.error(`[VTID-01190] ENFORCEMENT BLOCK: Spec not locked for ${vtid}`);
    return {
      allowed: false,
      error: `Spec is not locked for ${vtid} - cannot execute unlocked spec`,
      error_code: 'SPEC_NOT_LOCKED',
    };
  }

  return { allowed: true, spec };
}

/**
 * Require spec for execution - throws if spec requirement not met
 *
 * Use this in autopilot/validator/verification entry points.
 */
export async function requireSpec(vtid: string): Promise<VtidSpec> {
  const result = await enforceSpecRequirement(vtid);

  if (!result.allowed || !result.spec) {
    throw new Error(`[VTID-01190] SPEC REQUIRED: ${result.error}`);
  }

  return result.spec;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Emit checksum failure event to OASIS
 */
async function emitChecksumFailureEvent(vtid: string, source: 'cache' | 'database'): Promise<void> {
  await emitOasisEvent({
    vtid,
    type: 'governance.spec.checksum_failure' as any,
    source: 'vtid-spec-service',
    status: 'error',
    message: `CRITICAL: Spec checksum verification failed for ${vtid}`,
    payload: {
      vtid,
      source,
      failure_at: new Date().toISOString(),
      action: 'execution_blocked',
    },
  });
}

/**
 * Get spec content (convenience accessor for the spec text)
 */
export function getSpecText(spec: VtidSpec): string {
  return spec.spec_content.spec_text;
}

/**
 * Get spec title (convenience accessor)
 */
export function getSpecTitle(spec: VtidSpec): string {
  return spec.spec_content.title;
}

/**
 * Get spec domain (convenience accessor)
 */
export function getSpecDomain(spec: VtidSpec): string {
  return spec.spec_content.task_domain || spec.primary_domain;
}

/**
 * Get spec target paths (convenience accessor)
 */
export function getSpecTargetPaths(spec: VtidSpec): string[] {
  return spec.spec_content.target_paths || [];
}

// =============================================================================
// Legacy Compatibility (for gradual migration)
// =============================================================================

/**
 * Convert VtidSpec to legacy SpecSnapshot format
 *
 * This allows existing code that uses SpecSnapshot to work with the new
 * persistent spec system during migration.
 */
export function toLegacySnapshot(spec: VtidSpec): {
  id: string;
  vtid: string;
  title: string;
  spec_content: string;
  task_domain?: string;
  target_paths?: string[];
  created_at: string;
  checksum: string;
} {
  return {
    id: `spec-${spec.vtid}`,
    vtid: spec.vtid,
    title: spec.spec_content.title,
    spec_content: spec.spec_content.spec_text,
    task_domain: spec.spec_content.task_domain,
    target_paths: spec.spec_content.target_paths,
    created_at: spec.created_at,
    checksum: spec.spec_checksum,
  };
}

// =============================================================================
// Exports
// =============================================================================

export default {
  // Core operations
  createVtidSpec,
  getVtidSpec,
  vtidSpecExists,
  verifySpecChecksum,

  // Enforcement
  enforceSpecRequirement,
  requireSpec,

  // Utilities
  computeSpecChecksum,
  verifyChecksumLocally,
  clearSpecsCache,

  // Accessors
  getSpecText,
  getSpecTitle,
  getSpecDomain,
  getSpecTargetPaths,

  // Legacy compatibility
  toLegacySnapshot,
};
