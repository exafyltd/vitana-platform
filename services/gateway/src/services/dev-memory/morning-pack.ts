/**
 * VTID-04408 — the developer morning pack.
 *
 * What a session (a Claude Code session via its SessionStart hook, or the
 * Operator Console) should know before it starts: the owner's latest
 * handoffs, the knowledge the team recorded in the last week, and the
 * VTIDs still in progress. Read-only; built from dev_agent_memory and
 * vtid_ledger; every section fails open to an empty list with the reason
 * recorded, so a slow table never blocks a session from starting.
 *
 * Admin-facing, English by design.
 */

import { getSupabase, supa } from '../dev-autopilot-execute';
import type { DevMemoryRepo } from '../dev-agent-memory';

export const PACK_HANDOFF_DAYS = 7;
export const PACK_HANDOFF_LIMIT = 5;
export const PACK_KNOWLEDGE_DAYS = 7;
export const PACK_KNOWLEDGE_LIMIT = 12;
export const PACK_VTID_DAYS = 14;
export const PACK_VTID_LIMIT = 10;
export const PACK_TEXT_MAX_CHARS = 8_000;
export const PACK_ENTRY_MAX_CHARS = 700;

const KNOWLEDGE_CATEGORIES = ['decision', 'incident', 'gotcha', 'convention'];

export interface PackMemoryRow {
  id: string;
  category: string;
  title: string;
  content: string;
  vtid: string | null;
  importance: number;
  author_user_id: string | null;
  created_at: string;
}

export interface PackVtidRow {
  vtid: string;
  title: string | null;
  status: string;
  updated_at: string;
}

export interface MorningPack {
  generated_at: string;
  repo: DevMemoryRepo;
  author_user_id: string | null;
  handoffs: PackMemoryRow[];
  knowledge: PackMemoryRow[];
  open_vtids: PackVtidRow[];
  unavailable: string[];
  text: string;
}

function clip(text: string, max: number): string {
  const t = (text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Plain-text rendering for a hook to print or a prompt to include, capped. */
export function renderMorningPack(p: Omit<MorningPack, 'text'>): string {
  const out: string[] = [`# Morning pack — ${p.repo} (${p.generated_at.slice(0, 10)})`];
  out.push('', '## Handoffs');
  if (p.handoffs.length === 0) out.push('(none in the last week)');
  for (const h of p.handoffs) {
    out.push(`- ${h.created_at.slice(0, 16).replace('T', ' ')} — ${h.title}`, clip(h.content, PACK_ENTRY_MAX_CHARS).split('\n').map((l) => `  ${l}`).join('\n'));
  }
  out.push('', '## Recent knowledge');
  if (p.knowledge.length === 0) out.push('(nothing recorded in the last week)');
  for (const k of p.knowledge) {
    out.push(`- [${k.category}]${k.vtid ? ` ${k.vtid}` : ''} ${k.title}: ${clip(k.content, 300).replace(/\s+/g, ' ')}`);
  }
  out.push('', '## VTIDs in progress');
  if (p.open_vtids.length === 0) out.push('(none)');
  for (const v of p.open_vtids) out.push(`- ${v.vtid} — ${v.title || '(untitled)'} (updated ${v.updated_at.slice(0, 10)})`);
  if (p.unavailable.length) out.push('', `(unavailable: ${p.unavailable.join('; ')})`);
  const text = out.join('\n');
  return text.length > PACK_TEXT_MAX_CHARS ? `${text.slice(0, PACK_TEXT_MAX_CHARS - 12)}\n…[clipped]` : text;
}

export async function buildMorningPack(
  opts: { repo?: DevMemoryRepo; authorUserId?: string | null; now?: Date } = {},
): Promise<{ ok: true; pack: MorningPack } | { ok: false; error: 'unavailable' }> {
  const s = getSupabase();
  if (!s) return { ok: false, error: 'unavailable' };
  const now = opts.now || new Date();
  const repo: DevMemoryRepo = opts.repo || 'vitana-platform';
  const author = opts.authorUserId || null;
  const iso = (days: number) => encodeURIComponent(new Date(now.getTime() - days * 86_400_000).toISOString());
  const cols = 'id,category,title,content,vtid,importance,author_user_id,created_at';
  const authorFilter = author ? `&author_user_id=eq.${encodeURIComponent(author)}` : '';

  const [handoffs, knowledge, vtids] = await Promise.all([
    supa<PackMemoryRow[]>(s,
      `/rest/v1/dev_agent_memory?category=eq.handoff&superseded_by=is.null${authorFilter}&created_at=gte.${iso(PACK_HANDOFF_DAYS)}&select=${cols}&order=created_at.desc&limit=${PACK_HANDOFF_LIMIT}`),
    supa<PackMemoryRow[]>(s,
      `/rest/v1/dev_agent_memory?repo=eq.${repo}&category=in.(${KNOWLEDGE_CATEGORIES.join(',')})&superseded_by=is.null&author_user_id=is.null&created_at=gte.${iso(PACK_KNOWLEDGE_DAYS)}&select=${cols}&order=importance.desc,created_at.desc&limit=${PACK_KNOWLEDGE_LIMIT}`),
    supa<PackVtidRow[]>(s,
      `/rest/v1/vtid_ledger?status=eq.in_progress&is_terminal=is.false&deleted_at=is.null&updated_at=gte.${iso(PACK_VTID_DAYS)}&select=vtid,title,status,updated_at&order=updated_at.desc&limit=${PACK_VTID_LIMIT}`),
  ]);

  const unavailable: string[] = [];
  if (!handoffs.ok) unavailable.push(`handoffs: ${(handoffs.error || '').slice(0, 80)}`);
  if (!knowledge.ok) unavailable.push(`knowledge: ${(knowledge.error || '').slice(0, 80)}`);
  if (!vtids.ok) unavailable.push(`vtids: ${(vtids.error || '').slice(0, 80)}`);

  const base = {
    generated_at: now.toISOString(),
    repo,
    author_user_id: author,
    handoffs: handoffs.ok && handoffs.data ? handoffs.data : [],
    knowledge: knowledge.ok && knowledge.data ? knowledge.data : [],
    open_vtids: vtids.ok && vtids.data ? vtids.data : [],
    unavailable,
  };
  return { ok: true, pack: { ...base, text: renderMorningPack(base) } };
}
