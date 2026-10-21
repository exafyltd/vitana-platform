/**
 * VTID-05133 — what a connected AI assistant may use (table
 * ai_connection_grants, migration 20261013150000_vtid_05133_ai_connection_grants.sql).
 *
 * Supabase access tokens are not bound to one resource: a token minted for the
 * Commerce connector is accepted by any /mcp/* path. The grant row, keyed on
 * (member, OAuth client_id), is therefore what separates Community from
 * Commerce and what makes "Disconnect" in Maxina take effect at once.
 *
 *   Community (/mcp/community*): an active row carrying the tool's category,
 *     else refused (no row → permission_needed, revoked → refused).
 *   Commerce (/mcp, /mcp/chatgpt): a client WITH a row needs `commerce` and no
 *     revoked_at; a client with NO row (connected before this existed) keeps
 *     working exactly as before.
 *
 * Lookup failures fail closed for Community and for a Commerce client known to
 * have a row; a Commerce lookup that errors keeps today's behaviour (allowed),
 * because the Commerce tools already authorize every write by org admin and
 * refusing every supplier on a database blip is the larger harm.
 */
export const GRANT_CATEGORIES = ['profile', 'matches', 'people', 'activities', 'commerce'] as const;
export type GrantCategory = (typeof GRANT_CATEGORIES)[number];

export interface GrantRow {
  categories: string[];
  revoked_at: string | null;
}

type Select = {
  from: (t: string) => {
    select: (cols: string) => {
      eq: (c: string, v: unknown) => {
        eq: (c: string, v: unknown) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> };
      };
    };
  };
};

export type GrantLookup = { kind: 'row'; row: GrantRow } | { kind: 'none' } | { kind: 'error' };

export async function lookupGrant(s: Select | null, userId: string, clientId: string | null): Promise<GrantLookup> {
  if (!s || !clientId) return { kind: 'error' };
  try {
    const { data, error } = await s
      .from('ai_connection_grants')
      .select('categories, revoked_at')
      .eq('user_id', userId)
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) return { kind: 'error' };
    if (!data) return { kind: 'none' };
    const row = data as { categories?: unknown; revoked_at?: unknown };
    return {
      kind: 'row',
      row: {
        categories: Array.isArray(row.categories) ? row.categories.filter((c): c is string => typeof c === 'string') : [],
        revoked_at: typeof row.revoked_at === 'string' ? row.revoked_at : null,
      },
    };
  } catch {
    return { kind: 'error' };
  }
}

export type CommunityAccess =
  | { ok: true; categories: GrantCategory[] }
  | { ok: false; reason: 'permission_needed' | 'revoked' | 'lookup_failed' };

/** Community connector: an active row is required; the categories decide which tools run. */
export function communityAccess(lookup: GrantLookup): CommunityAccess {
  if (lookup.kind === 'error') return { ok: false, reason: 'lookup_failed' };
  if (lookup.kind === 'none') return { ok: false, reason: 'permission_needed' };
  if (lookup.row.revoked_at) return { ok: false, reason: 'revoked' };
  const categories = lookup.row.categories.filter((c): c is GrantCategory => (GRANT_CATEGORIES as readonly string[]).includes(c));
  return { ok: true, categories };
}

/** Commerce connector: unchanged for clients with no row; a row must carry `commerce`. */
export function commerceAllowed(lookup: GrantLookup): boolean {
  if (lookup.kind === 'none' || lookup.kind === 'error') return true;
  return !lookup.row.revoked_at && lookup.row.categories.includes('commerce');
}
