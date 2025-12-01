/**
 * Software Version Tracking - VTID-0510
 * Handles version ID generation and deployment record management
 */

import { emitOasisEvent } from '../services/oasis-event-service';

// ==================== Types ====================

export interface SoftwareVersion {
  id?: string;
  swv_id: string;
  service: string;
  git_commit: string;
  deploy_type: 'normal' | 'rollback';
  initiator: 'user' | 'agent';
  status: 'success' | 'failure';
  environment: string;
  created_at?: string;
}

export interface InsertSoftwareVersionParams {
  swv_id: string;
  service: string;
  git_commit: string;
  deploy_type: 'normal' | 'rollback';
  initiator: 'user' | 'agent';
  status: 'success' | 'failure';
  environment: string;
}

// ==================== Constants ====================

const SWV_PREFIX = 'SWV-';
const SWV_PADDING = 4; // SWV-0001, SWV-0002, etc.

// ==================== Helper Functions ====================

/**
 * Parse a SWV-#### ID and extract the numeric portion
 * Strict validator: returns null on any parse error
 */
function parseSWVNumber(swvId: string): number | null {
  if (!swvId || typeof swvId !== 'string') {
    return null;
  }

  if (!swvId.startsWith(SWV_PREFIX)) {
    return null;
  }

  const numericPart = swvId.slice(SWV_PREFIX.length);

  // Strict numeric validation - must be digits only
  if (!/^\d+$/.test(numericPart)) {
    return null;
  }

  const parsed = parseInt(numericPart, 10);

  // Ensure no NaN or invalid values
  if (isNaN(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

/**
 * Format a number as a SWV-#### ID
 */
function formatSWV(num: number): string {
  if (num < 0 || !Number.isInteger(num)) {
    throw new Error(`Invalid SWV number: ${num}`);
  }
  return `${SWV_PREFIX}${num.toString().padStart(SWV_PADDING, '0')}`;
}

// ==================== Core Functions ====================

/**
 * Get the next sequential SWV ID
 * Queries the database for the latest SWV-#### and increments
 * Returns SWV-0001 if no existing records
 */
export async function getNextSWV(): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[Versioning] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    throw new Error('Gateway misconfigured: missing Supabase credentials');
  }

  try {
    // Query for the latest swv_id by created_at DESC
    const response = await fetch(
      `${supabaseUrl}/rest/v1/software_versions?select=swv_id&order=created_at.desc&limit=1`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Versioning] Failed to query latest SWV: ${response.status} - ${errorText}`);
      throw new Error(`Database query failed: ${response.status}`);
    }

    const data = await response.json() as Array<{ swv_id: string }>;

    // If no existing records, start with SWV-0001
    if (!data || data.length === 0) {
      console.log('[Versioning] No existing versions found, starting with SWV-0001');
      return formatSWV(1);
    }

    const latestSwvId = data[0].swv_id;
    const latestNumber = parseSWVNumber(latestSwvId);

    if (latestNumber === null) {
      console.error(`[Versioning] Failed to parse latest SWV ID: ${latestSwvId}`);
      throw new Error(`Invalid SWV ID format in database: ${latestSwvId}`);
    }

    const nextNumber = latestNumber + 1;
    const nextSwvId = formatSWV(nextNumber);

    console.log(`[Versioning] Latest: ${latestSwvId}, Next: ${nextSwvId}`);
    return nextSwvId;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Versioning] Error getting next SWV: ${errorMessage}`);
    throw error;
  }
}

/**
 * Insert a new software version record
 * Also emits DEPLOY_VERSION_RECORDED OASIS event
 */
export async function insertSoftwareVersion(
  params: InsertSoftwareVersionParams
): Promise<{ ok: boolean; swv_id?: string; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[Versioning] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    return { ok: false, error: 'Gateway misconfigured: missing Supabase credentials' };
  }

  // Validate swv_id format before insert
  const parsedNum = parseSWVNumber(params.swv_id);
  if (parsedNum === null) {
    console.error(`[Versioning] Invalid SWV ID format: ${params.swv_id}`);
    return { ok: false, error: `Invalid SWV ID format: ${params.swv_id}` };
  }

  const payload: SoftwareVersion = {
    swv_id: params.swv_id,
    service: params.service,
    git_commit: params.git_commit,
    deploy_type: params.deploy_type,
    initiator: params.initiator,
    status: params.status,
    environment: params.environment,
  };

  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/software_versions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Versioning] Failed to insert version: ${response.status} - ${errorText}`);
      return { ok: false, error: `Failed to insert version: ${response.status}` };
    }

    const inserted = await response.json();
    const insertedRecord = Array.isArray(inserted) ? inserted[0] : inserted;

    console.log(`[Versioning] Inserted software version: ${params.swv_id} for ${params.service}`);

    // Emit OASIS event for version recording
    await emitOasisEvent({
      vtid: `VTID-0510-${params.swv_id}`,
      type: 'cicd.deploy.version.recorded' as any,
      source: 'gateway-versioning',
      status: 'success',
      message: `Software version ${params.swv_id} recorded for ${params.service}`,
      payload: {
        swv_id: params.swv_id,
        service: params.service,
        git_commit: params.git_commit,
        deploy_type: params.deploy_type,
        initiator: params.initiator,
        status: params.status,
        environment: params.environment,
      },
    });

    return { ok: true, swv_id: insertedRecord.swv_id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Versioning] Error inserting version: ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Get deployment history (latest N deployments)
 */
export async function getDeploymentHistory(limit: number = 20): Promise<{
  ok: boolean;
  deployments?: SoftwareVersion[];
  error?: string;
}> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[Versioning] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    return { ok: false, error: 'Gateway misconfigured: missing Supabase credentials' };
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/software_versions?select=swv_id,created_at,git_commit,status,initiator,deploy_type,service,environment&order=created_at.desc&limit=${limit}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Versioning] Failed to fetch deployments: ${response.status} - ${errorText}`);
      return { ok: false, error: `Database query failed: ${response.status}` };
    }

    const deployments = await response.json() as SoftwareVersion[];
    return { ok: true, deployments };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Versioning] Error fetching deployments: ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }
}

// ==================== VTID-0524 Types ====================

export interface DeploymentWithVtid {
  vtid: string | null;
  swv: string;
  service: string;
  environment: string;
  status: string;
  created_at: string;
  commit: string;
}

/**
 * Get deployment history with VTID correlation (VTID-0524)
 * Queries software_versions and correlates with oasis_events for VTID data
 * Returns deployments sorted by created_at DESC with VTID when available
 */
export async function getDeploymentHistoryWithVtid(limit: number = 20): Promise<{
  ok: boolean;
  deployments?: DeploymentWithVtid[];
  error?: string;
}> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    console.error('[Versioning] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
    return { ok: false, error: 'Gateway misconfigured: missing Supabase credentials' };
  }

  try {
    // Step 1: Get software versions
    const versionsResponse = await fetch(
      `${supabaseUrl}/rest/v1/software_versions?select=swv_id,created_at,git_commit,status,service,environment&order=created_at.desc&limit=${limit}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!versionsResponse.ok) {
      const errorText = await versionsResponse.text();
      console.error(`[Versioning] Failed to fetch software versions: ${versionsResponse.status} - ${errorText}`);
      return { ok: false, error: `Database query failed: ${versionsResponse.status}` };
    }

    const versions = await versionsResponse.json() as Array<{
      swv_id: string;
      created_at: string;
      git_commit: string;
      status: string;
      service: string;
      environment: string;
    }>;

    if (!versions || versions.length === 0) {
      return { ok: true, deployments: [] };
    }

    // Step 2: Get VTID mappings from oasis_events for deploy version recorded events
    // Look for events where metadata contains the swv_id
    const swvIds = versions.map(v => v.swv_id);
    const vtidMap: Map<string, string> = new Map();

    // Query oasis_events for cicd.deploy.version.recorded events
    const eventsResponse = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?topic=eq.cicd.deploy.version.recorded&select=vtid,metadata&order=created_at.desc&limit=${limit * 2}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      }
    );

    if (eventsResponse.ok) {
      const events = await eventsResponse.json() as Array<{
        vtid: string;
        metadata: { swv_id?: string } | null;
      }>;

      // Build a map of swv_id -> vtid
      for (const event of events) {
        const eventSwvId = event.metadata?.swv_id;
        if (eventSwvId && swvIds.includes(eventSwvId) && !vtidMap.has(eventSwvId)) {
          vtidMap.set(eventSwvId, event.vtid);
        }
      }
    } else {
      // Log warning but continue - VTID data is optional
      console.warn('[Versioning] Could not fetch VTID mappings from oasis_events, continuing without VTID data');
    }

    // Step 3: Map deployments with VTID correlation
    const deployments: DeploymentWithVtid[] = versions.map(v => ({
      vtid: vtidMap.get(v.swv_id) || null,
      swv: v.swv_id,
      service: v.service,
      environment: v.environment,
      status: v.status,
      created_at: v.created_at,
      commit: v.git_commit.substring(0, 7), // Short commit hash
    }));

    console.log(`[Versioning] Returning ${deployments.length} deployments with VTID correlation`);
    return { ok: true, deployments };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Versioning] Error fetching deployments with VTID: ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }
}

export default {
  getNextSWV,
  insertSoftwareVersion,
  getDeploymentHistory,
  getDeploymentHistoryWithVtid,
  parseSWVNumber,
  formatSWV,
};
