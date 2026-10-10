/**
 * VTID-05023 part 4, layer (b): POST /api/v1/internal/auth-bridge/user-event
 *
 * Receives the auth.users database webhook that
 * scripts/aws/supabase-cutover-auth-bridge.sql installs on Supabase (pg_net),
 * in the Supabase database-webhook shape:
 *   { type: 'INSERT' | 'UPDATE' | 'DELETE', schema: 'auth', table: 'users',
 *     record: {...} | null, old_record: {...} | null }
 *
 *   INSERT                        -> ensure_provisioned() on Aurora (what the six
 *                                    disabled sign-up triggers did) + active_tenant_id
 *                                    into app_metadata when missing
 *   UPDATE of email_confirmed_at  -> the same (idempotent; covers a lost INSERT)
 *   other UPDATE                  -> ignored (no trigger reacted to it before)
 *   DELETE                        -> auth_bridge_handle_deleted_user() on Aurora:
 *                                    what the public->auth.users FKs and the kept
 *                                    contacts-cleanup trigger did on Supabase
 *
 * Auth: `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>` only (machine caller;
 * an admin JWT is not accepted). Unset token -> every call is refused (401).
 * A failure answers 500 and is logged; pg_net does not retry, the
 * reconciliation job (AUTH_BRIDGE_RECONCILE_ENABLED) does.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { getAuthBridgeDeps, isUuid, provisionAuthUser, toBridgeAuthUser } from '../services/auth-bridge/auth-bridge';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();
const LOG = '[VTID-05023 auth-bridge]';

// Recorded only when Aurora actually changed (rows created, or a deletion processed). A failed
// emit is logged and never fails the webhook: provisioning already committed.
function recordTransition(type: 'auth_bridge.user.provisioned' | 'auth_bridge.user.deleted', userId: string, payload: Record<string, unknown>): void {
  emitOasisEvent({
    vtid: 'VTID-05023',
    type,
    source: 'gateway.auth-bridge',
    status: 'success',
    message: type === 'auth_bridge.user.provisioned' ? `member ${userId} provisioned on Aurora` : `member ${userId} cleaned up on Aurora`,
    payload: { user_id: userId, via: 'webhook', ...payload },
    actor_role: 'system',
    surface: 'system',
    vitana_id: null,
  }).then((r) => {
    if (!r.ok) console.error(`${LOG} OASIS ${type} for ${userId} not recorded: ${r.error}`);
  }).catch((err) => console.error(`${LOG} OASIS ${type} for ${userId} not recorded: ${err?.message ?? err}`));
}

function tokenMatches(presented: string): boolean {
  const configured = process.env.GATEWAY_SERVICE_TOKEN ?? '';
  if (!configured || !presented) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!process.env.GATEWAY_SERVICE_TOKEN) {
    console.error(`${LOG} GATEWAY_SERVICE_TOKEN is not set — refusing every webhook call`);
  }
  if (!tokenMatches(token)) {
    res.status(401).json({ ok: false, error: 'service token required' });
    return;
  }
  next();
}

const RecordSchema = z
  .object({
    id: z.string().refine(isUuid, 'id must be a uuid'),
    email: z.string().nullable().optional(),
    raw_user_meta_data: z.record(z.unknown()).nullable().optional(),
    raw_app_meta_data: z.record(z.unknown()).nullable().optional(),
    created_at: z.string().nullable().optional(),
    email_confirmed_at: z.string().nullable().optional(),
  })
  .passthrough();

const EventSchema = z.object({
  type: z.enum(['INSERT', 'UPDATE', 'DELETE']),
  schema: z.literal('auth').optional(),
  table: z.literal('users').optional(),
  record: RecordSchema.nullable().optional(),
  old_record: RecordSchema.partial().passthrough().nullable().optional(),
});

router.post('/user-event', requireServiceToken, async (req: Request, res: Response) => {
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'invalid auth.users event', details: parsed.error.issues.map((i) => i.message) });
  }
  const event = parsed.data;

  const deps = getAuthBridgeDeps();
  if (!deps) {
    console.error(`${LOG} no Supabase service credentials — ${event.type} not processed`);
    return res.status(503).json({ ok: false, error: 'auth bridge unavailable' });
  }

  try {
    if (event.type === 'DELETE') {
      const userId = event.old_record?.id;
      if (!isUuid(userId)) return res.status(400).json({ ok: false, error: 'DELETE needs old_record.id' });
      const result = await deps.store.handleDeletedUser(userId, 'webhook');
      console.log(`${LOG} deleted user ${userId}: ${JSON.stringify(result)}`);
      recordTransition('auth_bridge.user.deleted', userId, { result });
      return res.json({ ok: true, action: 'deleted', user_id: userId, result });
    }

    const record = event.record;
    if (!record) return res.status(400).json({ ok: false, error: `${event.type} needs record` });

    if (event.type === 'UPDATE') {
      const before = event.old_record?.email_confirmed_at ?? null;
      const after = record.email_confirmed_at ?? null;
      if (before === after) {
        return res.json({ ok: true, action: 'ignored', user_id: record.id });
      }
    }

    const user = toBridgeAuthUser(record);
    const result = await provisionAuthUser(deps, user);
    console.log(
      `${LOG} ${event.type} ${user.id}: ${result.provisioned ? `provisioned [${result.created.join(', ')}]` : 'already provisioned'}` +
        (result.active_tenant_set ? `, active_tenant_id=${result.active_tenant_id}` : ''),
    );
    if (result.provisioned) {
      recordTransition('auth_bridge.user.provisioned', user.id, { event: event.type, created: result.created, active_tenant_set: result.active_tenant_set });
    }
    return res.json({ ok: true, action: result.provisioned ? 'provisioned' : 'already_provisioned', user_id: user.id, result });
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error(`${LOG} ${event.type} failed: ${message}`);
    return res.status(500).json({ ok: false, error: message });
  }
});

export default router;
