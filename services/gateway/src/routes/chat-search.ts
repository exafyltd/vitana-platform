/**
 * VTID-05309 (messenger-ux-v2/api-message-search, plan I5) — message search
 * across the caller's DMs and groups. Mounted by routes/chat.ts at
 * /api/v1/chat/search.
 *
 *   GET /?q=&scope=all|dm:<peerId>|group:<groupId>&from=&to=&type=any|image|video|file|voice|link
 *        &sender=<userId>&cursor=&limit≤50
 *   → { ok, results: [{ message_id, conversation_key, sender_id, created_at, snippet, message_type }], next_cursor }
 *
 * Authorization is server-side and applied twice: the query only asks for the
 * caller's tenant, DMs the caller sent or received and groups the caller is a
 * member of; every returned row is checked again against the same rule
 * (defence in depth — a filter mistake can never leak a row). A group scope the
 * caller is not a member of is 403.
 *
 * `q` ≥ 3 characters (the shortest a trigram index serves) → ILIKE on the text,
 * with LIKE wildcards escaped (a `%` matches a literal `%`), plus the first
 * attachment's file name. Backed by the pg_trgm GIN index of
 * 20261022090000_vtid_05309_chat_message_search.sql (without it the search
 * still works, as a scan). Newest first, cursor = (created_at, id).
 * Rate-limited per member (30 searches / minute).
 */
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireAuth, requireTenant, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { listChatGroupMemberships } from './chat-groups-repository';

const router = Router();

export const SEARCH_MIN_CHARS = 3;
export const SEARCH_MAX_CHARS = 200;
export const SEARCH_MAX_LIMIT = 50;
export const SNIPPET_RADIUS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_TYPES = new Set(['any', 'image', 'video', 'file', 'voice', 'link']);
const LINK_RE = /https?:\/\/\S+/i;

function getSupabase(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE!);
}

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/** Escapes LIKE wildcards so the text is matched literally. */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** A PostgREST filter value in double quotes (commas, dots and parentheses are safe inside). */
export function quoteFilterValue(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export type SearchScope = { kind: 'all' } | { kind: 'dm'; peerId: string } | { kind: 'group'; groupId: string };

export function parseScope(raw: unknown): SearchScope | null {
  if (raw === undefined || raw === '' || raw === 'all') return { kind: 'all' };
  if (typeof raw !== 'string') return null;
  const m = /^(dm|group):(.+)$/.exec(raw);
  if (!m || !UUID_RE.test(m[2])) return null;
  return m[1] === 'dm' ? { kind: 'dm', peerId: m[2].toLowerCase() } : { kind: 'group', groupId: m[2].toLowerCase() };
}

export interface Cursor { created_at: string; id: string }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.created_at}|${c.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): Cursor | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const [created_at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    if (!created_at || !id || !UUID_RE.test(id) || !Number.isFinite(Date.parse(created_at))) return null;
    return { created_at, id };
  } catch {
    return null;
  }
}

export interface SearchRow {
  id: string;
  tenant_id: string | null;
  sender_id: string;
  receiver_id: string | null;
  group_id: string | null;
  content: string | null;
  message_type: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
}

/** Defence in depth: may `me` see this row? */
export function isVisibleTo(row: SearchRow, me: string, tenantId: string, myGroups: ReadonlySet<string>): boolean {
  if (row.tenant_id !== tenantId) return false;
  if (row.group_id) return myGroups.has(row.group_id);
  return row.sender_id === me || row.receiver_id === me;
}

/** Is the (visible) row inside the requested scope? */
export function inScope(row: SearchRow, scope: SearchScope, me: string): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'group') return row.group_id === scope.groupId;
  return !row.group_id && ((row.sender_id === me && row.receiver_id === scope.peerId) || (row.sender_id === scope.peerId && row.receiver_id === me));
}

export function conversationKeyOf(row: SearchRow, me: string): string {
  if (row.group_id) return `group:${row.group_id}`;
  return `dm:${row.sender_id === me ? row.receiver_id : row.sender_id}`;
}

function attachmentsOf(row: SearchRow): Array<Record<string, any>> {
  const a = row.metadata?.attachments;
  return Array.isArray(a) ? a.filter((x) => x && typeof x === 'object') : [];
}

function kindOf(att: Record<string, any>): string {
  const mime = typeof att.mime === 'string' ? att.mime.toLowerCase() : '';
  const type = typeof att.type === 'string' ? att.type.toLowerCase() : '';
  if (type === 'voice' || type === 'audio' || mime.startsWith('audio/')) return 'voice';
  if (type === 'image' || mime.startsWith('image/')) return 'image';
  if (type === 'video' || mime.startsWith('video/')) return 'video';
  return 'file';
}

/** Does the row match the `type` filter? */
export function matchesType(row: SearchRow, type: string): boolean {
  if (type === 'any') return true;
  if (type === 'link') return LINK_RE.test(row.content ?? '');
  if (type === 'voice' && (row.message_type === 'voice')) return true;
  return attachmentsOf(row).some((a) => kindOf(a) === type);
}

/** Does the row contain `q` (case-insensitive, literal) in its text or a file name? */
export function matchesQuery(row: SearchRow, q: string): boolean {
  const needle = q.toLowerCase();
  if ((row.content ?? '').toLowerCase().includes(needle)) return true;
  return attachmentsOf(row).some((a) => String(a.filename ?? a.name ?? '').toLowerCase().includes(needle));
}

/** ±60 characters around the first hit (text), else the matching file name. */
export function snippetFor(row: SearchRow, q: string, radius = SNIPPET_RADIUS): string {
  const text = row.content ?? '';
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at >= 0) {
    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + q.length + radius);
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  }
  const file = attachmentsOf(row).map((a) => String(a.filename ?? a.name ?? '')).find((n) => n.toLowerCase().includes(q.toLowerCase()));
  return file ?? text.slice(0, radius * 2);
}

/** The PostgREST `or` filter of the rows `me` may see. */
export function visibilityFilter(me: string, groupIds: readonly string[]): string {
  const parts = [`and(group_id.is.null,sender_id.eq.${me})`, `and(group_id.is.null,receiver_id.eq.${me})`];
  if (groupIds.length > 0) parts.push(`group_id.in.(${groupIds.join(',')})`);
  return parts.join(',');
}

/** The PostgREST `or` filter of rows containing `q` (text or the first attachment's file name). */
export function queryFilter(q: string): string {
  const v = quoteFilterValue(`%${escapeLike(q)}%`);
  return [
    `content.ilike.${v}`,
    `metadata->attachments->0->>filename.ilike.${v}`,
    `metadata->attachments->0->>name.ilike.${v}`,
  ].join(',');
}

// ── Route ──────────────────────────────────────────────────────────────────

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: Request) => `u:${(req as AuthenticatedRequest).identity?.user_id ?? 'anon'}`,
  validate: false,
  message: { ok: false, error: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false,
});

function isoOrNull(raw: unknown): string | null | false {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) return false;
  return new Date(raw).toISOString();
}

router.get('/', requireAuth, requireTenant, searchLimiter, async (req: Request, res: Response) => {
  const { identity } = req as AuthenticatedRequest;
  if (!identity?.user_id || !identity.tenant_id) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const me = identity.user_id;
  const tenantId = identity.tenant_id;

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < SEARCH_MIN_CHARS) return res.status(400).json({ ok: false, error: 'query_too_short', min: SEARCH_MIN_CHARS });
  if (q.length > SEARCH_MAX_CHARS) return res.status(400).json({ ok: false, error: 'query_too_long', max: SEARCH_MAX_CHARS });
  const scope = parseScope(req.query.scope);
  if (!scope) return res.status(400).json({ ok: false, error: 'invalid_scope' });
  const type = typeof req.query.type === 'string' && req.query.type ? req.query.type : 'any';
  if (!SEARCH_TYPES.has(type)) return res.status(400).json({ ok: false, error: 'invalid_type' });
  const from = isoOrNull(req.query.from);
  const to = isoOrNull(req.query.to);
  if (from === false || to === false) return res.status(400).json({ ok: false, error: 'invalid_date' });
  const sender = typeof req.query.sender === 'string' && req.query.sender ? req.query.sender : null;
  if (sender && !UUID_RE.test(sender)) return res.status(400).json({ ok: false, error: 'invalid_sender' });
  const cursor = req.query.cursor === undefined || req.query.cursor === '' ? null : decodeCursor(req.query.cursor);
  if (req.query.cursor && !cursor) return res.status(400).json({ ok: false, error: 'invalid_cursor' });
  const limitRaw = Number(req.query.limit ?? 20);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limitRaw))) : 20;

  const sb = getSupabase();
  try {
    const { data: memberships, error: memErr } = await listChatGroupMemberships(sb, me, tenantId);
    if (memErr) throw new Error(memErr.message);
    const myGroups = new Set(((memberships as Array<{ group_id: string }> | null) ?? []).map((m) => m.group_id));
    if (scope.kind === 'group' && !myGroups.has(scope.groupId)) {
      return res.status(403).json({ ok: false, error: 'not_a_member' });
    }

    // Rows are post-filtered (type, defence in depth), so scan a few pages' worth.
    const scan = Math.min(limit * 3, 150);
    let query = sb
      .from('chat_messages')
      .select('id, tenant_id, sender_id, receiver_id, group_id, content, message_type, metadata, created_at')
      .eq('tenant_id', tenantId)
      .neq('message_type', 'system');
    if (scope.kind === 'all') {
      query = query.or(visibilityFilter(me, Array.from(myGroups)));
    } else if (scope.kind === 'dm') {
      query = query.is('group_id', null).or(`and(sender_id.eq.${me},receiver_id.eq.${scope.peerId}),and(sender_id.eq.${scope.peerId},receiver_id.eq.${me})`);
    } else {
      query = query.eq('group_id', scope.groupId);
    }
    query = query.or(queryFilter(q));
    if (sender) query = query.eq('sender_id', sender);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', to);
    if (type === 'voice') query = query.in('message_type', ['voice', 'attachment']);
    else if (type === 'image' || type === 'video' || type === 'file') query = query.eq('message_type', 'attachment');
    if (cursor) query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
    const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(scan);
    if (error) throw new Error(error.message);

    const rows = ((data as SearchRow[] | null) ?? []);
    const results: Array<Record<string, unknown>> = [];
    let last: SearchRow | null = null;
    for (const row of rows) {
      if (results.length >= limit) break;
      last = row;
      if (!isVisibleTo(row, me, tenantId, myGroups) || !inScope(row, scope, me)) {
        console.warn(`[ChatSearch] dropped a row outside the caller's scope (${row.id})`);
        continue;
      }
      if (!matchesQuery(row, q) || !matchesType(row, type)) continue;
      results.push({
        message_id: row.id,
        conversation_key: conversationKeyOf(row, me),
        sender_id: row.sender_id,
        created_at: row.created_at,
        snippet: snippetFor(row, q),
        message_type: row.message_type ?? 'text',
      });
    }
    // More may follow when the page filled up or the scan window was full.
    const more = results.length >= limit || rows.length === scan;
    const next_cursor = more && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null;
    return res.json({ ok: true, results, next_cursor });
  } catch (err: any) {
    console.warn(`[ChatSearch] search failed: ${err?.message || err}`);
    return res.status(500).json({ ok: false, error: 'search_failed' });
  }
});

export default router;
