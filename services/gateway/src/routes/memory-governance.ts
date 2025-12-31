/**
 * VTID-01099: Memory Governance & User Controls
 *
 * Gateway routes for memory governance controls:
 * - Visibility: who can see which memory domains
 * - Locks: prevent entities from downstream use
 * - Deletions: soft-delete with cascade tracking
 * - Exports: user data portability
 *
 * Endpoints:
 * - GET    /api/v1/memory/settings            - Get all memory settings
 * - POST   /api/v1/memory/settings/visibility - Set visibility for domain
 * - POST   /api/v1/memory/lock                - Lock an entity
 * - POST   /api/v1/memory/unlock              - Unlock an entity
 * - DELETE /api/v1/memory/entity              - Soft-delete an entity
 * - GET    /api/v1/memory/locks               - Get locked entities
 * - POST   /api/v1/memory/export              - Request data export
 * - GET    /api/v1/memory/export/:id          - Get export status
 *
 * Dependencies:
 * - VTID-01099 (Supabase migration)
 * - VTID-01105 (Memory core routes)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01099: Constants & Types
// =============================================================================

/**
 * Valid visibility domains
 */
const VISIBILITY_DOMAINS = ['diary', 'garden', 'relationships', 'longevity', 'timeline'] as const;
type VisibilityDomain = typeof VISIBILITY_DOMAINS[number];

/**
 * Valid visibility levels
 */
const VISIBILITY_LEVELS = ['private', 'connections', 'professionals', 'custom'] as const;
type VisibilityLevel = typeof VISIBILITY_LEVELS[number];

/**
 * Valid entity types for lock/delete
 */
const ENTITY_TYPES = ['diary', 'garden_node', 'relationship_edge', 'timeline_entry', 'memory_item'] as const;
type EntityType = typeof ENTITY_TYPES[number];

/**
 * Valid export domains
 */
const EXPORT_DOMAINS = ['diary', 'garden', 'relationships', 'longevity', 'timeline', 'topic_profile'] as const;
type ExportDomain = typeof EXPORT_DOMAINS[number];

/**
 * Valid export formats
 */
const EXPORT_FORMATS = ['json', 'csv'] as const;
type ExportFormat = typeof EXPORT_FORMATS[number];

// =============================================================================
// VTID-01099: Request Schemas
// =============================================================================

const SetVisibilitySchema = z.object({
  domain: z.enum(VISIBILITY_DOMAINS),
  visibility: z.enum(VISIBILITY_LEVELS),
  custom_rules: z.record(z.unknown()).optional().nullable()
});

const LockEntitySchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().uuid(),
  reason: z.string().optional().nullable()
});

const UnlockEntitySchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().uuid()
});

const DeleteEntitySchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().uuid()
});

const RequestExportSchema = z.object({
  domains: z.array(z.enum(EXPORT_DOMAINS)).min(1),
  format: z.enum(EXPORT_FORMATS).default('json')
});

const GetLocksQuerySchema = z.object({
  entity_type: z.enum(ENTITY_TYPES).optional()
});

// =============================================================================
// VTID-01099: Helper Functions
// =============================================================================

/**
 * Extract Bearer token from Authorization header
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Emit a memory governance OASIS event
 */
async function emitGovernanceEvent(
  type: 'memory.visibility.updated' | 'memory.locked' | 'memory.unlocked' | 'memory.deleted' | 'memory.export.requested' | 'memory.export.ready',
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01099',
    type: type as any,
    source: 'memory-governance',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01099] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01099: Routes
// =============================================================================

/**
 * GET /settings -> GET /api/v1/memory/settings
 *
 * Get all memory governance settings for the current user.
 */
router.get('/settings', async (req: Request, res: Response) => {
  console.log('[VTID-01099] GET /memory/settings');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('memory_get_settings');

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        console.warn('[VTID-01099] memory_get_settings RPC not found (migration not deployed yet)');
        return res.status(503).json({
          ok: false,
          error: 'Memory governance RPC not available (VTID-01099 migration pending)'
        });
      }
      console.error('[VTID-01099] memory_get_settings RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    return res.status(200).json({
      ok: true,
      visibility: data.visibility || {},
      locks: data.locks || {},
      deletions_count: data.deletions_count || 0,
      exports: data.exports || []
    });
  } catch (err: any) {
    console.error('[VTID-01099] memory_get_settings error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /settings/visibility -> POST /api/v1/memory/settings/visibility
 *
 * Set visibility preference for a memory domain.
 */
router.post('/settings/visibility', async (req: Request, res: Response) => {
  console.log('[VTID-01099] POST /memory/settings/visibility');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = SetVisibilitySchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { domain, visibility, custom_rules } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('memory_set_visibility', {
      p_domain: domain,
      p_visibility: visibility,
      p_custom_rules: custom_rules || null
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'Memory governance RPC not available (VTID-01099 migration pending)'
        });
      }
      console.error('[VTID-01099] memory_set_visibility RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitGovernanceEvent(
      'memory.visibility.updated',
      'success',
      `Visibility set for ${domain}: ${visibility}`,
      {
        domain,
        visibility,
        has_custom_rules: !!custom_rules
      }
    );

    console.log(`[VTID-01099] Visibility set: ${domain} -> ${visibility}`);

    return res.status(200).json({
      ok: true,
      id: data.id,
      domain: data.domain,
      visibility: data.visibility
    });
  } catch (err: any) {
    console.error('[VTID-01099] memory_set_visibility error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /lock -> POST /api/v1/memory/lock
 *
 * Lock an entity from downstream use.
 */
router.post('/lock', async (req: Request, res: Response) => {
  console.log('[VTID-01099] POST /memory/lock');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = LockEntitySchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { entity_type, entity_id, reason } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('memory_lock_entity', {
      p_entity_type: entity_type,
      p_entity_id: entity_id,
      p_reason: reason || null
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'Memory governance RPC not available (VTID-01099 migration pending)'
        });
      }
      console.error('[VTID-01099] memory_lock_entity RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitGovernanceEvent(
      'memory.locked',
      'success',
      `Entity locked: ${entity_type}/${entity_id}`,
      {
        entity_type,
        entity_id,
        reason
      }
    );

    console.log(`[VTID-01099] Entity locked: ${entity_type}/${entity_id}`);

    return res.status(200).json({
      ok: true,
      id: data.id,
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      locked: data.locked
    });
  } catch (err: any) {
    console.error('[VTID-01099] memory_lock_entity error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /unlock -> POST /api/v1/memory/unlock
 *
 * Unlock a previously locked entity.
 */
router.post('/unlock', async (req: Request, res: Response) => {
  console.log('[VTID-01099] POST /memory/unlock');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = UnlockEntitySchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { entity_type, entity_id } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('memory_unlock_entity', {
      p_entity_type: entity_type,
      p_entity_id: entity_id
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'Memory governance RPC not available (VTID-01099 migration pending)'
        });
      }
      console.error('[VTID-01099] memory_unlock_entity RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitGovernanceEvent(
      'memory.unlocked',
      'success',
      `Entity unlocked: ${entity_type}/${entity_id}`,
      {
        entity_type,
        entity_id,
        was_locked: data.unlocked
      }
    );

    console.log(`[VTID-01099] Entity unlocked: ${entity_type}/${entity_id}`);

    return res.status(200).json({
      ok: true,
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      unlocked: data.unlocked
    });
  } catch (err: any) {
    console.error('[VTID-01099] memory_unlock_entity error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * DELETE /entity -> DELETE /api/v1/memory/entity
 *
 * Soft-delete an entity with cascade tracking.
 */
router.delete('/entity', async (req: Request, res: Response) => {
  console.log('[VTID-01099] DELETE /memory/entity');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = DeleteEntitySchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { entity_type, entity_id } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('memory_delete_entity', {
      p_entity_type: entity_type,
      p_entity_id: entity_id
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'Memory governance RPC not available (VTID-01099 migration pending)'
        });
      }
      console.error('[VTID-01099] memory_delete_entity RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitGovernanceEvent(
      'memory.deleted',
      'success',
      `Entity deleted: ${entity_type}/${entity_id}`,
      {
        entity_type,
        entity_id,
        cascade: data.cascade
      }
    );

    console.log(`[VTID-01099] Entity deleted: ${entity_type}/${entity_id}`);

    return res.status(200).json({
      ok: true,
      id: data.id,
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      deleted: data.deleted,
      cascade: data.cascade
    });
  } catch (err: any) {
    console.error('[VTID-01099] memory_delete_entity error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /locks -> GET /api/v1/memory/locks
 *
 * Get list of locked entities.
 */
router.get('/locks', async (req: Request, res: Response) => {
  console.log('[VTID-01099] GET /memory/locks');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Parse query parameters
  const queryValidation = GetLocksQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { entity_type } = queryValidation.data;

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('memory_get_locked_entities', {
      p_entity_type: entity_type || null
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'Memory governance RPC not available (VTID-01099 migration pending)'
        });
      }
      console.error('[VTID-01099] memory_get_locked_entities RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    return res.status(200).json({
      ok: true,
      locks: data.locks || [],
      filter: { entity_type }
    });
  } catch (err: any) {
    console.error('[VTID-01099] memory_get_locked_entities error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * POST /export -> POST /api/v1/memory/export
 *
 * Request a data export.
 */
router.post('/export', async (req: Request, res: Response) => {
  console.log('[VTID-01099] POST /memory/export');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate request body
  const validation = RequestExportSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { domains, format } = validation.data;

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('memory_request_export', {
      p_domains: domains,
      p_format: format
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'Memory governance RPC not available (VTID-01099 migration pending)'
        });
      }
      console.error('[VTID-01099] memory_request_export RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    // Emit OASIS event
    await emitGovernanceEvent(
      'memory.export.requested',
      'info',
      `Export requested: ${domains.join(', ')} (${format})`,
      {
        export_id: data.id,
        domains,
        format
      }
    );

    console.log(`[VTID-01099] Export requested: ${data.id}`);

    return res.status(200).json({
      ok: true,
      id: data.id,
      domains: data.domains,
      format: data.format,
      status: data.status
    });
  } catch (err: any) {
    console.error('[VTID-01099] memory_request_export error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/**
 * GET /export/:id -> GET /api/v1/memory/export/:id
 *
 * Get export status.
 */
router.get('/export/:id', async (req: Request, res: Response) => {
  const exportId = req.params.id;
  console.log(`[VTID-01099] GET /memory/export/${exportId}`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHENTICATED'
    });
  }

  // Validate export_id is UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(exportId)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid export ID format'
    });
  }

  try {
    const supabase = createUserSupabaseClient(token);
    const { data, error } = await supabase.rpc('memory_get_export_status', {
      p_export_id: exportId
    });

    if (error) {
      if (error.message.includes('function') && error.message.includes('does not exist')) {
        return res.status(503).json({
          ok: false,
          error: 'Memory governance RPC not available (VTID-01099 migration pending)'
        });
      }
      console.error('[VTID-01099] memory_get_export_status RPC error:', error.message);
      return res.status(502).json({
        ok: false,
        error: error.message
      });
    }

    if (!data?.ok) {
      if (data?.error === 'NOT_FOUND') {
        return res.status(404).json({
          ok: false,
          error: 'NOT_FOUND',
          message: 'Export not found'
        });
      }
      return res.status(400).json({
        ok: false,
        error: data?.error || 'Unknown error',
        message: data?.message
      });
    }

    return res.status(200).json({
      ok: true,
      id: data.id,
      domains: data.domains,
      format: data.format,
      status: data.status,
      file_url: data.file_url || null,
      file_size_bytes: data.file_size_bytes || null,
      error_message: data.error_message || null,
      created_at: data.created_at,
      expires_at: data.expires_at
    });
  } catch (err: any) {
    console.error('[VTID-01099] memory_get_export_status error:', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

export default router;

/**
 * Export helper functions for use in other routes
 */
export { emitGovernanceEvent };
