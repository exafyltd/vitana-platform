/**
 * VTID-01181: System Controls Service
 *
 * Provides DB-backed runtime control for system capabilities without redeploys.
 * Supports:
 * - Reading current control states with caching (5-15 seconds)
 * - Updating controls with reason, duration, and audit trail
 * - Auto-expiry checks for time-limited arming
 * - OASIS event emission for every change
 *
 * HARD GOVERNANCE:
 * - Controls are DISARMED by default
 * - Arming requires reason + duration (mandatory)
 * - Every change is audited to system_control_audit
 * - Every change emits governance.control.updated event
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';

// =============================================================================
// Environment Configuration
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Cache configuration (5-15 seconds to reduce DB load)
const CACHE_TTL_MS = 10_000; // 10 seconds

// =============================================================================
// Types
// =============================================================================

export interface SystemControl {
  key: string;
  enabled: boolean;
  scope: { environment: string; [key: string]: unknown };
  reason: string;
  expires_at: string | null;
  updated_by: string | null;
  updated_by_role: string | null;
  updated_at: string;
}

export interface SystemControlAudit {
  id: string;
  key: string;
  from_enabled: boolean;
  to_enabled: boolean;
  reason: string;
  expires_at: string | null;
  scope: { environment: string; [key: string]: unknown };
  updated_by: string | null;
  updated_by_role: string | null;
  created_at: string;
}

export interface UpdateControlRequest {
  enabled: boolean;
  reason: string;
  duration_minutes?: number | null; // null = no expiry (only for specific roles)
  updated_by: string;
  updated_by_role: string;
}

export interface ControlUpdateResult {
  ok: boolean;
  control?: SystemControl;
  audit_id?: string;
  error?: string;
}

// =============================================================================
// In-Memory Cache
// =============================================================================

interface CacheEntry {
  control: SystemControl;
  fetchedAt: number;
}

const controlsCache = new Map<string, CacheEntry>();

/**
 * Clear cache for a specific key or all keys
 */
export function clearControlsCache(key?: string): void {
  if (key) {
    controlsCache.delete(key);
  } else {
    controlsCache.clear();
  }
}

/**
 * Check if a cached entry is still valid
 */
function isCacheValid(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Get a system control by key, with caching and auto-expiry check.
 * Returns null if control doesn't exist.
 */
export async function getSystemControl(key: string): Promise<SystemControl | null> {
  // Check cache first
  const cached = controlsCache.get(key);
  if (cached && isCacheValid(cached)) {
    // Apply expiry check on cached data
    return applyExpiryCheck(cached.control);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-01181] Missing Supabase config, cannot read system control');
    return null;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/system_controls?key=eq.${encodeURIComponent(key)}`,
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
      console.error(`[VTID-01181] Failed to fetch control ${key}: ${response.status} - ${errorText}`);
      return null;
    }

    const rows = (await response.json()) as SystemControl[];
    if (rows.length === 0) {
      return null;
    }

    const control = rows[0];

    // Update cache
    controlsCache.set(key, { control, fetchedAt: Date.now() });

    // Apply expiry check
    return applyExpiryCheck(control);
  } catch (error) {
    console.error(`[VTID-01181] Error fetching control ${key}:`, error);
    return null;
  }
}

/**
 * Apply expiry check - if expires_at has passed, treat as disabled
 */
function applyExpiryCheck(control: SystemControl): SystemControl {
  if (control.expires_at && new Date(control.expires_at) <= new Date()) {
    return { ...control, enabled: false };
  }
  return control;
}

/**
 * Get all system controls
 */
export async function getAllSystemControls(): Promise<SystemControl[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-01181] Missing Supabase config, cannot list system controls');
    return [];
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/system_controls?order=key.asc`,
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
      console.error(`[VTID-01181] Failed to list controls: ${response.status} - ${errorText}`);
      return [];
    }

    const rows = (await response.json()) as SystemControl[];

    // Apply expiry checks and update cache
    return rows.map((control) => {
      controlsCache.set(control.key, { control, fetchedAt: Date.now() });
      return applyExpiryCheck(control);
    });
  } catch (error) {
    console.error('[VTID-01181] Error listing controls:', error);
    return [];
  }
}

/**
 * Update a system control (arm/disarm).
 * Creates audit record and emits OASIS event.
 */
export async function updateSystemControl(
  key: string,
  request: UpdateControlRequest
): Promise<ControlUpdateResult> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ok: false, error: 'Gateway misconfigured: missing Supabase credentials' };
  }

  // Validation: reason is always required
  if (!request.reason || request.reason.trim().length === 0) {
    return { ok: false, error: 'Reason is required' };
  }

  // Get current state for audit
  const currentControl = await getSystemControl(key);
  const fromEnabled = currentControl?.enabled ?? false;

  // Compute expires_at
  let expiresAt: string | null = null;
  if (request.enabled && request.duration_minutes) {
    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + request.duration_minutes);
    expiresAt = expiry.toISOString();
  }

  // Current scope (preserve existing or use default)
  const scope = currentControl?.scope ?? { environment: 'dev-sandbox' };

  // Build the updated control record
  const updatedControl: SystemControl = {
    key,
    enabled: request.enabled,
    scope,
    reason: request.reason,
    expires_at: expiresAt,
    updated_by: request.updated_by,
    updated_by_role: request.updated_by_role,
    updated_at: new Date().toISOString(),
  };

  try {
    // Step 1: Upsert the control
    const upsertResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/system_controls`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(updatedControl),
      }
    );

    if (!upsertResponse.ok) {
      const errorText = await upsertResponse.text();
      console.error(`[VTID-01181] Failed to upsert control ${key}: ${upsertResponse.status} - ${errorText}`);
      return { ok: false, error: `Database update failed: ${upsertResponse.status}` };
    }

    const upsertedRows = (await upsertResponse.json()) as SystemControl[];
    const savedControl = upsertedRows[0];

    // Clear cache for this key
    clearControlsCache(key);

    // Step 2: Create audit record
    const auditRecord: Omit<SystemControlAudit, 'id' | 'created_at'> = {
      key,
      from_enabled: fromEnabled,
      to_enabled: request.enabled,
      reason: request.reason,
      expires_at: expiresAt,
      scope,
      updated_by: request.updated_by,
      updated_by_role: request.updated_by_role,
    };

    const auditResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/system_control_audit`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          Prefer: 'return=representation',
        },
        body: JSON.stringify(auditRecord),
      }
    );

    let auditId: string | undefined;
    if (auditResponse.ok) {
      const auditRows = (await auditResponse.json()) as SystemControlAudit[];
      auditId = auditRows[0]?.id;
    } else {
      console.warn(`[VTID-01181] Failed to create audit record, but control was updated`);
    }

    // Step 3: Emit OASIS event (mandatory per VTID-01181)
    await emitOasisEvent({
      vtid: 'VTID-01181',
      type: 'governance.control.updated',
      source: 'system-controls-service',
      status: request.enabled ? 'success' : 'info',
      message: `System control ${key} ${request.enabled ? 'ENABLED' : 'DISABLED'}: ${request.reason}`,
      payload: {
        key,
        enabled: request.enabled,
        from_enabled: fromEnabled,
        reason: request.reason,
        expires_at: expiresAt,
        scope,
        updated_by: request.updated_by,
        updated_by_role: request.updated_by_role,
        audit_id: auditId,
      },
    });

    console.log(
      `[VTID-01181] Control ${key} ${request.enabled ? 'ENABLED' : 'DISABLED'} by ${request.updated_by} (${request.updated_by_role})`
    );

    return {
      ok: true,
      control: savedControl,
      audit_id: auditId,
    };
  } catch (error) {
    console.error(`[VTID-01181] Error updating control ${key}:`, error);
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Get audit history for a specific control
 */
export async function getControlAuditHistory(
  key: string,
  limit: number = 50
): Promise<SystemControlAudit[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.warn('[VTID-01181] Missing Supabase config, cannot fetch audit history');
    return [];
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/system_control_audit?key=eq.${encodeURIComponent(key)}&order=created_at.desc&limit=${limit}`,
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
      console.error(`[VTID-01181] Failed to fetch audit history for ${key}: ${response.status} - ${errorText}`);
      return [];
    }

    return (await response.json()) as SystemControlAudit[];
  } catch (error) {
    console.error(`[VTID-01181] Error fetching audit history for ${key}:`, error);
    return [];
  }
}

/**
 * Check if VTID allocator is enabled.
 * Consults DB control with caching and expiry checking.
 * Returns true if enabled (either via env var OR DB control).
 */
export async function isVtidAllocatorEnabled(): Promise<boolean> {
  // Check env var first (backward compatibility)
  if (process.env.VTID_ALLOCATOR_ENABLED === 'true') {
    return true;
  }

  // Check DB control
  const control = await getSystemControl('vtid_allocator_enabled');
  if (!control) {
    return false; // Control doesn't exist = disabled
  }

  return control.enabled;
}

/**
 * VTID-01187: Check if autopilot execution is armed.
 *
 * This is the PRIMARY governance gate for autonomous task execution.
 * Even if AUTOPILOT_LOOP_ENABLED=true (loop is running), execution
 * will not happen unless this DB control is also armed.
 *
 * This separation allows:
 * - Loop to keep running (monitoring, status updates)
 * - Execution to be armed/disarmed at runtime without redeploy
 * - Emergency stop without killing the loop process
 *
 * Returns true ONLY if DB control 'autopilot_execution_enabled' is armed.
 */
export async function isAutopilotExecutionArmed(): Promise<boolean> {
  const control = await getSystemControl('autopilot_execution_enabled');

  // Control must exist AND be enabled
  if (!control) {
    console.log('[VTID-01187] autopilot_execution_enabled control not found - execution DISARMED');
    return false;
  }

  if (!control.enabled) {
    console.log('[VTID-01187] autopilot_execution_enabled is DISARMED');
    return false;
  }

  console.log('[VTID-01187] autopilot_execution_enabled is ARMED');
  return true;
}
