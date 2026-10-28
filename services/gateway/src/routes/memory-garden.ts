/**
 * VTID-04388: Memory Garden API — the user's window into the canonical store.
 *
 *   GET    /api/v1/memory/garden/entries?category=&limit=   facts + episodes
 *   GET    /api/v1/memory/garden/categories                 counts per category
 *   POST   /api/v1/memory/garden/entries                    add a fact or a note
 *   PATCH  /api/v1/memory/garden/entries/:kind/:id          edit
 *   DELETE /api/v1/memory/garden/entries/:kind/:id          delete / forget
 *
 * VTID-04390: the one diary write path for every diary surface.
 *   POST   /api/v1/memory/diary/entries        save (diary row + episode + Index)
 *   DELETE /api/v1/memory/diary/entries/:id    delete (diary row + episode)
 *
 * VTID-04391: the Daily summary screen.
 *   GET    /api/v1/memory/daily-learning?limit=  the user's daily learnings
 *
 * Auth: requireAuthWithTenant; tenant and user come from the JWT only. Every
 * read and write is filtered by both, so a caller can never touch another
 * user's memory even with a guessed id.
 */

import { Router, Response } from 'express';
import { requireAuthWithTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  listGardenEntries,
  summarizeCategories,
  addGardenFact,
  addGardenNote,
  editGardenEpisode,
  editGardenFact,
  deleteGardenEntry,
  isGardenCategory,
  type GardenIdentity,
  type GardenWriteResult,
} from '../services/memory/garden';
import { normalizeDiaryInput, saveDiaryEntry, deleteDiaryEntry } from '../services/memory/diary';
import { listDailyLearnings } from '../services/memory/daily-learning';
import { refreshSnapshotAfterMemoryEdit } from '../services/conversation/brain-core-snapshot';

const router = Router();
const VTID = 'VTID-04388';

function identityOf(req: AuthenticatedRequest): GardenIdentity | null {
  const id = req.identity;
  if (!id?.tenant_id || !id?.user_id) return null;
  const headerRole = req.header('X-Vitana-Active-Role');
  return { tenant_id: id.tenant_id, user_id: id.user_id, active_role: headerRole || (id as any).role || null };
}

function kindOf(v: string): 'fact' | 'episode' | null {
  return v === 'fact' || v === 'episode' ? v : null;
}

function emitWrite(identity: GardenIdentity, action: string, kind: string, id: string | null): void {
  // VTID-04627: the next voice session must see this change, not a snapshot from before it.
  refreshSnapshotAfterMemoryEdit({ tenantId: identity.tenant_id, userId: identity.user_id });
  emitOasisEvent({
    vtid: VTID,
    type: 'memory.garden.edited' as any,
    source: 'memory-garden',
    status: 'info',
    message: `Memory Garden ${action} (${kind})`,
    payload: { tenant_id: identity.tenant_id, user_id: identity.user_id, action, kind, id },
  }).catch(() => undefined);
}

function sendWrite(res: Response, r: GardenWriteResult, status = 200) {
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error, vtid: VTID });
  return res.status(status).json({ ok: true, id: r.id, vtid: VTID });
}

router.get('/memory/garden/entries', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  const identity = identityOf(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', vtid: VTID });
  const category = req.query.category;
  if (category !== undefined && !isGardenCategory(category)) {
    return res.status(400).json({ ok: false, error: 'INVALID_CATEGORY', vtid: VTID });
  }
  const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED', vtid: VTID });
  try {
    const entries = await listGardenEntries(sb, identity, {
      category: category as any,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return res.json({ ok: true, entries, vtid: VTID });
  } catch (err: any) {
    console.error(`[${VTID}] list failed: ${err?.message ?? err}`);
    return res.status(502).json({ ok: false, error: 'READ_FAILED', vtid: VTID });
  }
});

router.get('/memory/garden/categories', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  const identity = identityOf(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', vtid: VTID });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED', vtid: VTID });
  try {
    const entries = await listGardenEntries(sb, identity, { limit: 500 });
    const categories = summarizeCategories(entries);
    return res.json({ ok: true, total: entries.length, categories, vtid: VTID });
  } catch (err: any) {
    console.error(`[${VTID}] categories failed: ${err?.message ?? err}`);
    return res.status(502).json({ ok: false, error: 'READ_FAILED', vtid: VTID });
  }
});

router.post('/memory/garden/entries', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis — emitted through emitWrite() → emitOasisEvent('memory.garden.edited')
  const identity = identityOf(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', vtid: VTID });
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED', vtid: VTID });
  if (body.kind === 'fact') {
    const r = await addGardenFact(sb, identity, String(body.fact_key ?? ''), String(body.fact_value ?? ''));
    if (r.ok) emitWrite(identity, 'added', 'fact', r.id);
    return sendWrite(res, r, 201);
  }
  if (body.kind === 'note') {
    const category = body.category ?? 'uncategorized';
    if (!isGardenCategory(category)) return res.status(400).json({ ok: false, error: 'INVALID_CATEGORY', vtid: VTID });
    const r = await addGardenNote(sb, identity, String(body.content ?? ''), category);
    if (r.ok) emitWrite(identity, 'added', 'note', r.id);
    return sendWrite(res, r, 201);
  }
  return res.status(400).json({ ok: false, error: 'INVALID_KIND', vtid: VTID });
});

router.patch('/memory/garden/entries/:kind/:id', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis — emitted through emitWrite() → emitOasisEvent('memory.garden.edited')
  const identity = identityOf(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', vtid: VTID });
  const kind = kindOf(req.params.kind);
  if (!kind) return res.status(400).json({ ok: false, error: 'INVALID_KIND', vtid: VTID });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED', vtid: VTID });
  const value = String((req.body ?? {}).content ?? '');
  const category = (req.body ?? {}).category;
  if (category !== undefined && !isGardenCategory(category)) {
    return res.status(400).json({ ok: false, error: 'INVALID_CATEGORY', vtid: VTID });
  }
  const r = kind === 'fact'
    ? await editGardenFact(sb, identity, req.params.id, value)
    : await editGardenEpisode(sb, identity, req.params.id, value, category);
  if (r.ok) emitWrite(identity, 'edited', kind, r.id);
  return sendWrite(res, r);
});

router.delete('/memory/garden/entries/:kind/:id', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis — emitted through emitWrite() → emitOasisEvent('memory.garden.edited')
  const identity = identityOf(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', vtid: VTID });
  const kind = kindOf(req.params.kind);
  if (!kind) return res.status(400).json({ ok: false, error: 'INVALID_KIND', vtid: VTID });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED', vtid: VTID });
  const r = await deleteGardenEntry(sb, identity, kind, req.params.id);
  if (r.ok) emitWrite(identity, 'deleted', kind, r.id);
  return sendWrite(res, r);
});

router.post('/memory/diary/entries', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  const identity = identityOf(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', vtid: 'VTID-04390' });
  const parsed = normalizeDiaryInput(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error, vtid: 'VTID-04390' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED', vtid: 'VTID-04390' });
  const r = await saveDiaryEntry(sb, identity, parsed.input);
  if (!r.ok) return res.status(r.status ?? 502).json({ ok: false, error: r.error, vtid: 'VTID-04390' });
  emitOasisEvent({
    vtid: 'VTID-04390',
    type: 'memory.diary.saved' as any,
    source: 'memory-garden',
    status: 'info',
    message: `Diary entry saved (${parsed.input.source})`,
    payload: {
      tenant_id: identity.tenant_id,
      user_id: identity.user_id,
      diary_entry_id: r.entry?.id,
      memory_item_id: r.memory_item_id ?? null,
      source: parsed.input.source,
      health_features_written: r.index?.health_features_written ?? 0,
    },
  }).catch(() => undefined);
  return res.status(201).json({ ok: true, entry: r.entry, memory_item_id: r.memory_item_id, index: r.index, vtid: 'VTID-04390' });
});

router.delete('/memory/diary/entries/:id', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis — emitted through emitWrite() → emitOasisEvent('memory.garden.edited')
  const identity = identityOf(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', vtid: 'VTID-04390' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED', vtid: 'VTID-04390' });
  const r = await deleteDiaryEntry(sb, identity, req.params.id);
  if (!r.ok) return res.status(r.status ?? 502).json({ ok: false, error: r.error, vtid: 'VTID-04390' });
  emitWrite(identity, 'deleted', 'diary', req.params.id);
  return res.json({ ok: true, vtid: 'VTID-04390' });
});

router.get('/memory/daily-learning', requireAuthWithTenant, async (req: AuthenticatedRequest, res: Response) => {
  const identity = identityOf(req);
  if (!identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED', vtid: 'VTID-04391' });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ ok: false, error: 'SUPABASE_NOT_CONFIGURED', vtid: 'VTID-04391' });
  const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
  try {
    const learnings = await listDailyLearnings(sb, identity, Number.isFinite(limit) ? limit : 14);
    return res.json({ ok: true, learnings, vtid: 'VTID-04391' });
  } catch (err: any) {
    console.error(`[VTID-04391] daily learning read failed: ${err?.message ?? err}`);
    return res.status(502).json({ ok: false, error: 'READ_FAILED', vtid: 'VTID-04391' });
  }
});

export default router;
