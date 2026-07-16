/**
 * Discovery voice tools (VTID-02773, VTID-02775, VTID-02777, VTID-02780).
 *
 * Search/news, Autopilot recommendation management, intent management, and
 * match tools for the ORB assistant (community role). Every handler REUSES
 * verified existing backings rather than inventing new ones:
 *
 *   - global_search        → profiles + profile_posts + global_community_events
 *                            + community_groups + products_catalog +
 *                            services_catalog (all verified in migrations /
 *                            social-memory-repository / orb-tools-shared).
 *   - browse_news_feed     → social-memory repository (fetchCandidatePosts —
 *                            the same privacy-filtered "interesting posts"
 *                            source the social-memory service uses).
 *   - snooze/dismiss/explain_recommendation
 *                          → autopilot_recommendations + the SAME
 *                            snooze_autopilot_recommendation /
 *                            reject_autopilot_recommendation RPCs the Command
 *                            Hub routes call (routes/autopilot-recommendations.ts).
 *   - update/delete_intent → user_intents, mirroring PATCH /api/v1/intents/:id
 *                            and POST /api/v1/intents/:id/close (routes/intents.ts).
 *                            "Delete" maps to status='closed' — the platform's
 *                            only removal path (no hard-delete exists).
 *   - browse_intent_board  → user_intents open-board query, mirroring
 *                            GET /api/v1/intent-board (partner_seek excluded,
 *                            never the user's own posts).
 *   - dispute_match        → intent_disputes via raiseDispute()
 *                            (services/intent-dispute-service.ts, VTID-01976).
 *   - find_perfect_match   → runFindMatch() (services/intent-find-match.ts,
 *                            BOOTSTRAP-FIND-MATCH-VOICE) fused with the Life
 *                            Compass goal + weakest Vitana Index pillar, the
 *                            same fusion inputs find_perfect_product /
 *                            find_perfect_practitioner use (VTID-02830).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import {
  fetchExclusions,
  fetchFollowEdges,
  fetchCandidatePosts,
  fetchPeople,
  type RawPost,
} from '../social-memory/social-memory-repository';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authGate(tool: string, id: OrbToolIdentity, needTenant = false): OrbToolResult | null {
  if (!id.user_id || (needTenant && !id.tenant_id)) {
    return { ok: false, error: `${tool} requires an authenticated user.` };
  }
  return null;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/** Strip characters that would break a PostgREST .or() filter string. */
function orSafe(term: string): string {
  return term.replace(/[,()*]/g, ' ').trim();
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function whenLabel(iso: string | null | undefined): string {
  if (!iso) return 'date TBD';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'date TBD';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function snippet(text: string | null | undefined, max = 90): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Life-Compass goal + weakest Vitana Index pillar — the same fusion inputs
 * find_perfect_product / find_perfect_practitioner use. Uses the corrected
 * life_compass schema (primary_goal / category / is_active, per VTID-03022).
 * Best-effort: both lookups fail soft.
 */
async function getCompassAndWeakestPillar(
  sb: SupabaseClient,
  userId: string,
): Promise<{ compass_goal: string | null; compass_category: string | null; weakest_pillar: string | null }> {
  let goal: string | null = null;
  let category: string | null = null;
  let weakest: string | null = null;
  try {
    const { data } = await sb
      .from('life_compass')
      .select('primary_goal, category')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = data as { primary_goal: string | null; category: string | null } | null;
    goal = (row?.primary_goal || '').trim() || null;
    category = (row?.category || '').trim() || null;
  } catch {
    /* best-effort */
  }
  try {
    const { data } = await sb
      .from('vitana_index_scores')
      .select('pillars')
      .eq('user_id', userId)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const pillars = (data as { pillars: Record<string, number> | null } | null)?.pillars;
    if (pillars && typeof pillars === 'object') {
      const pairs = Object.entries(pillars).filter(([, v]) => typeof v === 'number');
      pairs.sort((a, b) => a[1] - b[1]);
      weakest = pairs[0]?.[0] ?? null;
    }
  } catch {
    /* best-effort */
  }
  return { compass_goal: goal, compass_category: category, weakest_pillar: weakest };
}

// ---------------------------------------------------------------------------
// global_search — unified search across people / posts / events / groups /
// products / services (VTID-02773)
// ---------------------------------------------------------------------------

interface SearchGroups {
  people: Array<{ user_id: string; display_name: string | null; handle: string | null; vitana_id: string | null; city: string | null }>;
  posts: Array<{ id: string; author: string; snippet: string; created_at: string }>;
  events: Array<{ id: string; title: string; start_time: string; location: string | null }>;
  groups: Array<{ id: string; name: string; topic_key: string | null; description: string | null }>;
  products: Array<{ id: string; name: string; product_type: string | null }>;
  services: Array<{ id: string; name: string; service_type: string | null; provider_name: string | null }>;
}

export async function tool_global_search(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('global_search', id);
  if (gate) return gate;
  const query = String(args.query ?? '').trim();
  if (query.length < 2) {
    return { ok: false, error: 'global_search requires a query of at least 2 characters.' };
  }
  const perCategory = clampInt(args.limit, 1, 5, 3);
  const safe = orSafe(query);

  const found: SearchGroups = { people: [], posts: [], events: [], groups: [], products: [], services: [] };

  // Privacy filters for the people/posts lanes. FAIL CLOSED: if exclusions
  // cannot be loaded we skip those two lanes rather than risk surfacing
  // blocked/muted authors (social-memory contract).
  let excl: { blocked: Set<string>; muted: Set<string>; hidden_posts: Set<string> } | null = null;
  try {
    excl = await fetchExclusions(id.user_id);
  } catch {
    excl = null;
  }

  const tasks: Promise<void>[] = [];

  // People — public-safe profile columns only (social-memory PROFILE_COLS subset).
  if (excl) {
    const blocked = excl.blocked;
    tasks.push(
      (async () => {
        try {
          const { data } = await sb
            .from('profiles')
            .select('user_id, display_name, handle, vitana_id, city')
            .or(`display_name.ilike.*${safe}*,handle.ilike.*${safe}*`)
            .limit(perCategory + 5);
          for (const row of (data as SearchGroups['people'] | null) ?? []) {
            if (row.user_id === id.user_id || blocked.has(row.user_id)) continue;
            if (found.people.length < perCategory) found.people.push(row);
          }
        } catch {
          /* lane is best-effort */
        }
      })(),
    );

    // Posts — public + moderation-approved only (mirrors fetchCandidatePosts filters).
    const exclusions = excl;
    tasks.push(
      (async () => {
        try {
          const { data } = await sb
            .from('profile_posts')
            .select('id, user_id, content, created_at')
            .eq('is_public', true)
            .neq('moderation_status', 'rejected')
            .ilike('content', `%${query}%`)
            .order('created_at', { ascending: false })
            .limit(perCategory + 5);
          const rows = ((data as Array<{ id: string; user_id: string; content: string | null; created_at: string }> | null) ?? []).filter(
            (p) =>
              !exclusions.blocked.has(p.user_id) &&
              !exclusions.muted.has(p.user_id) &&
              !exclusions.hidden_posts.has(p.id),
          );
          const authors = await fetchPeople(rows.map((r) => r.user_id));
          for (const p of rows.slice(0, perCategory)) {
            const person = authors.get(p.user_id);
            found.posts.push({
              id: p.id,
              author: person?.display_name || person?.handle || 'a member',
              snippet: snippet(p.content),
              created_at: p.created_at,
            });
          }
        } catch {
          /* lane is best-effort */
        }
      })(),
    );
  }

  // Events — upcoming only (same table tool_search_events uses).
  tasks.push(
    (async () => {
      try {
        const { data } = await sb
          .from('global_community_events')
          .select('id, title, start_time, location')
          .gte('start_time', new Date().toISOString())
          .or(`title.ilike.*${safe}*,description.ilike.*${safe}*`)
          .order('start_time', { ascending: true })
          .limit(perCategory);
        found.events = (data as SearchGroups['events'] | null) ?? [];
      } catch {
        /* lane is best-effort */
      }
    })(),
  );

  // Groups — tenant-scoped public groups (mirrors tool_search_community).
  if (id.tenant_id) {
    tasks.push(
      (async () => {
        try {
          const { data } = await sb
            .from('community_groups')
            .select('id, name, topic_key, description')
            .eq('tenant_id', id.tenant_id)
            .eq('is_public', true)
            .or(`name.ilike.*${safe}*,description.ilike.*${safe}*,topic_key.ilike.*${safe}*`)
            .limit(perCategory);
          found.groups = (data as SearchGroups['groups'] | null) ?? [];
        } catch {
          /* lane is best-effort */
        }
      })(),
    );

    // Products / services catalogs (tenant-scoped tables, VTID-01092).
    tasks.push(
      (async () => {
        try {
          const { data } = await sb
            .from('products_catalog')
            .select('id, name, product_type')
            .eq('tenant_id', id.tenant_id)
            .ilike('name', `%${query}%`)
            .limit(perCategory);
          found.products = (data as SearchGroups['products'] | null) ?? [];
        } catch {
          /* catalog may not be deployed in this env */
        }
      })(),
    );
    tasks.push(
      (async () => {
        try {
          const { data } = await sb
            .from('services_catalog')
            .select('id, name, service_type, provider_name')
            .eq('tenant_id', id.tenant_id)
            .ilike('name', `%${query}%`)
            .limit(perCategory);
          found.services = (data as SearchGroups['services'] | null) ?? [];
        } catch {
          /* catalog may not be deployed in this env */
        }
      })(),
    );
  }

  await Promise.allSettled(tasks);

  const lines: string[] = [];
  if (found.people.length > 0) {
    lines.push(
      `People: ${found.people
        .map((p) => `${p.display_name || p.handle || 'a member'}${p.city ? ` (${p.city})` : ''}`)
        .join('; ')}.`,
    );
  }
  if (found.posts.length > 0) {
    lines.push(`Posts: ${found.posts.map((p) => `${p.author}: "${p.snippet}"`).join('; ')}.`);
  }
  if (found.events.length > 0) {
    lines.push(
      `Events: ${found.events
        .map((e) => `${e.title} (${whenLabel(e.start_time)}${e.location ? `, ${e.location}` : ''})`)
        .join('; ')}.`,
    );
  }
  if (found.groups.length > 0) {
    lines.push(`Groups: ${found.groups.map((g) => `${g.name} — ${snippet(g.description, 60)}`).join('; ')}.`);
  }
  if (found.products.length > 0) {
    lines.push(`Products: ${found.products.map((p) => p.name).join(', ')}.`);
  }
  if (found.services.length > 0) {
    lines.push(
      `Services: ${found.services.map((s) => `${s.name}${s.provider_name ? ` by ${s.provider_name}` : ''}`).join('; ')}.`,
    );
  }

  if (lines.length === 0) {
    return {
      ok: true,
      result: { query, ...found },
      text: `Nothing in the community matched "${query}" — no people, posts, events, groups, or catalog items. Suggest rephrasing or trying a broader term.`,
    };
  }

  return {
    ok: true,
    result: { query, ...found },
    text:
      `Search results for "${query}" — present the most relevant category first, top hits only:\n` +
      lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// browse_news_feed — read the community feed aloud (VTID-02773)
// ---------------------------------------------------------------------------

export async function tool_browse_news_feed(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('browse_news_feed', id);
  if (gate) return gate;
  const scope = args.scope === 'following' ? 'following' : 'all';
  const limit = clampInt(args.limit, 1, 10, 5);

  // FAIL CLOSED on privacy filters — never surface content from blocked/muted
  // authors (same contract as the social read tools).
  let excl: { blocked: Set<string>; muted: Set<string>; hidden_posts: Set<string> };
  try {
    excl = await fetchExclusions(id.user_id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return {
      ok: false,
      error: `browse_news_feed: privacy filters unavailable (${msg}). Tell the user honestly you cannot read the feed right now — do not guess.`,
    };
  }

  try {
    const edges = await fetchFollowEdges(id.user_id, excl.blocked, 100);
    const followedIds = edges.following.map((e) => e.person.user_id);

    if (scope === 'following' && followedIds.length === 0) {
      return {
        ok: true,
        result: { scope, total: 0, posts: [] },
        text:
          'The user does not follow anyone yet, so the "following" feed is empty. Say so plainly and offer to show the whole community feed or find interesting members to follow.',
      };
    }

    let posts: RawPost[] = await fetchCandidatePosts(id.user_id, followedIds, excl, 40);
    if (scope === 'following') {
      const followedSet = new Set(followedIds);
      posts = posts.filter((p) => followedSet.has(p.user_id));
    }
    posts.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const top = posts.slice(0, limit);

    if (top.length === 0) {
      return {
        ok: true,
        result: { scope, total: 0, posts: [] },
        text:
          scope === 'following'
            ? 'No recent posts from the people the user follows (last 14 days). Say so plainly and offer the full community feed instead.'
            : 'The community feed has no recent posts (last 14 days). Say so plainly — and suggest the user posts something to get things going.',
      };
    }

    const people = await fetchPeople(top.map((p) => p.user_id));
    const lines = top.map((p) => {
      const person = people.get(p.user_id);
      const name = person?.display_name || person?.handle || 'A member';
      const likes = p.likes_count > 0 ? `, ${p.likes_count} like${p.likes_count === 1 ? '' : 's'}` : '';
      return `${name}: "${snippet(p.content)}" (${timeAgo(p.created_at)}${likes})`;
    });

    return {
      ok: true,
      result: {
        scope,
        total: top.length,
        posts: top.map((p) => ({
          id: p.id,
          author: people.get(p.user_id)?.display_name || people.get(p.user_id)?.handle || null,
          content: snippet(p.content, 200),
          likes_count: p.likes_count,
          comments_count: p.comments_count,
          created_at: p.created_at,
        })),
      },
      text:
        `Top ${top.length} post${top.length === 1 ? '' : 's'} from the community feed (${scope === 'following' ? 'people the user follows' : 'everyone'}), newest first: ` +
        `${lines.join('; ')}. Speak each as author plus a one-line summary — do not read long posts verbatim.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'browse_news_feed failed' };
  }
}

// ---------------------------------------------------------------------------
// Autopilot recommendation management (VTID-02775)
// ---------------------------------------------------------------------------

interface RecRow {
  id: string;
  title: string | null;
  summary: string | null;
  domain: string | null;
  risk_level: string | null;
  impact_score: number | null;
  effort_score: number | null;
  status: string | null;
  snoozed_until: string | null;
  user_id: string | null;
  source_type?: string | null;
  source_ref?: string | null;
  contribution_vector?: Record<string, number> | null;
  economic_axis?: string | null;
  created_at?: string | null;
}

type RecResolution =
  | { ok: true; rec: RecRow }
  | { ok: false; res: OrbToolResult };

/**
 * Resolve a spoken recommendation reference (UUID or title/summary fragment)
 * to ONE autopilot_recommendations row the user is allowed to act on
 * (their own row or a system-wide row — same ownership rule as
 * tool_activate_recommendation).
 */
async function resolveRecommendation(
  sb: SupabaseClient,
  id: OrbToolIdentity,
  ref: string,
  statuses: string[] | null,
  toolName: string,
): Promise<RecResolution> {
  // No spoken reference — the user is likely reacting to the recommendation
  // Vitana just offered (e.g. declined "activate?" but asked to hear more,
  // or said "snooze/dismiss it" without naming it). That offer's id is the
  // pending CTA persisted by wake-brief-wiring into orb_session_state (same
  // fallback tool_activate_recommendation already uses below — see
  // orb-tools-shared.ts). Without this, every such follow-up fell through to
  // the broad "several recommendations match" ambiguity branch further down,
  // even when there was only ever one specific recommendation on the table.
  if (!ref && id.user_id) {
    try {
      const { readOrbSessionState } = await import('../orb/orb-session-state');
      const pending = await readOrbSessionState<{ tool?: string; payload?: { id?: string } }>(
        sb,
        id.user_id,
        'pending_cta',
      );
      const pendingId =
        pending &&
        pending.value &&
        pending.value.tool === 'activate_recommendation' &&
        typeof pending.value.payload?.id === 'string'
          ? pending.value.payload.id.trim()
          : '';
      if (pendingId) {
        const { data, error } = await sb
          .from('autopilot_recommendations')
          .select('*')
          .eq('id', pendingId)
          .maybeSingle();
        const rec = !error ? (data as RecRow | null) : null;
        if (rec && (!rec.user_id || rec.user_id === id.user_id)) {
          return { ok: true, rec };
        }
        // Pending CTA is stale/inaccessible — fall through to the normal
        // resolution below rather than failing outright.
      }
    } catch {
      // Best-effort fallback only; fall through to normal resolution.
    }
  }

  if (UUID_RX.test(ref)) {
    const { data, error } = await sb
      .from('autopilot_recommendations')
      .select('*')
      .eq('id', ref)
      .maybeSingle();
    if (error) return { ok: false, res: { ok: false, error: `${toolName}: ${error.message}` } };
    const rec = data as RecRow | null;
    if (!rec) {
      return {
        ok: false,
        res: {
          ok: true,
          result: { found: false },
          text: 'I could not find that recommendation — it may have been removed. Offer to list the current recommendations instead.',
        },
      };
    }
    if (rec.user_id && rec.user_id !== id.user_id) {
      return { ok: false, res: { ok: false, error: 'recommendation_belongs_to_another_user' } };
    }
    return { ok: true, rec };
  }

  let q = sb
    .from('autopilot_recommendations')
    .select('*')
    .or(`user_id.eq.${id.user_id},user_id.is.null`)
    .order('created_at', { ascending: false })
    .limit(5);
  if (statuses && statuses.length > 0) q = q.in('status', statuses);
  if (ref) {
    const safe = orSafe(ref);
    q = q.or(`title.ilike.*${safe}*,summary.ilike.*${safe}*`);
  }
  const { data, error } = await q;
  if (error) return { ok: false, res: { ok: false, error: `${toolName}: ${error.message}` } };
  const rows = (data as RecRow[] | null) ?? [];
  if (rows.length === 0) {
    return {
      ok: false,
      res: {
        ok: true,
        result: { found: false, query: ref },
        text: ref
          ? `No open recommendation matched "${ref}". Offer to read the current recommendation list so the user can pick one.`
          : 'There are no open recommendations right now. Say so plainly.',
      },
    };
  }
  if (rows.length > 1 && ref) {
    const titles = rows.slice(0, 3).map((r) => `"${r.title ?? 'untitled'}"`);
    return {
      ok: false,
      res: {
        ok: true,
        result: {
          ambiguous: true,
          candidates: rows.slice(0, 3).map((r) => ({ id: r.id, title: r.title })),
        },
        text: `Several recommendations match: ${titles.join(', ')}. Ask the user which one they mean, then call ${toolName} again with its id.`,
      },
    };
  }
  if (rows.length > 1) {
    const titles = rows.slice(0, 3).map((r) => `"${r.title ?? 'untitled'}"`);
    return {
      ok: false,
      res: {
        ok: true,
        result: {
          ambiguous: true,
          candidates: rows.slice(0, 3).map((r) => ({ id: r.id, title: r.title })),
        },
        text: `There are several open recommendations: ${titles.join(', ')}. Ask which one the user means, then call ${toolName} again with its id.`,
      },
    };
  }
  return { ok: true, rec: rows[0] };
}

export async function tool_snooze_recommendation(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('snooze_recommendation', id);
  if (gate) return gate;
  const ref = String(args.recommendation ?? args.id ?? '').trim();
  // Same 1–168h clamp as POST /recommendations/:id/snooze.
  const hours = clampInt(args.hours, 1, 168, 24);

  try {
    const resolved = await resolveRecommendation(sb, id, ref, ['new', 'snoozed'], 'snooze_recommendation');
    if (!resolved.ok) return resolved.res;
    const rec = resolved.rec;

    // Same RPC the Command Hub snooze button calls (VTID-01180).
    const { data, error } = await sb.rpc('snooze_autopilot_recommendation', {
      p_recommendation_id: rec.id,
      p_hours: hours,
    });
    if (error) return { ok: false, error: `snooze_recommendation: ${error.message}` };
    const resp = data as { ok?: boolean; error?: string; snoozed_until?: string } | null;
    if (!resp?.ok) {
      return { ok: false, error: resp?.error || 'snooze_failed' };
    }
    const until = resp.snoozed_until ? whenLabel(resp.snoozed_until) : `${hours} hours from now`;
    const title = rec.title ?? 'that recommendation';
    return {
      ok: true,
      result: { id: rec.id, title: rec.title, hours, snoozed_until: resp.snoozed_until ?? null },
      text: `Done — "${title}" is snoozed for ${hours} hours. It will come back around ${until}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'snooze_recommendation failed' };
  }
}

export async function tool_dismiss_recommendation(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('dismiss_recommendation', id);
  if (gate) return gate;
  const ref = String(args.recommendation ?? args.id ?? '').trim();
  const reason = String(args.reason ?? '').trim();
  const confirmed = args.confirm === true;

  try {
    const resolved = await resolveRecommendation(sb, id, ref, ['new', 'snoozed'], 'dismiss_recommendation');
    if (!resolved.ok) return resolved.res;
    const rec = resolved.rec;
    const title = rec.title ?? 'that recommendation';

    // Destructive — confirm first, per the shared confirm-flow contract.
    if (!confirmed) {
      return {
        ok: true,
        result: { stage: 'awaiting_confirmation', recommendation_id: rec.id, title: rec.title },
        text: `Confirm with the user first: dismiss "${title}" for good (it will not come back)? On a clear yes, call dismiss_recommendation again with recommendation="${rec.id}" and confirm=true.`,
      };
    }

    // Same RPC the Command Hub dismiss button calls (VTID-01180).
    const { data, error } = await sb.rpc('reject_autopilot_recommendation', {
      p_recommendation_id: rec.id,
      p_reason: reason || null,
    });
    if (error) return { ok: false, error: `dismiss_recommendation: ${error.message}` };
    const resp = data as { ok?: boolean; error?: string } | null;
    if (!resp?.ok) {
      return { ok: false, error: resp?.error || 'dismiss_failed' };
    }
    return {
      ok: true,
      result: { id: rec.id, title: rec.title, status: 'rejected' },
      text: `Done — "${title}" is dismissed and will not be suggested again.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'dismiss_recommendation failed' };
  }
}

const PILLAR_KEYS = ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'];

export async function tool_explain_recommendation(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('explain_recommendation', id);
  if (gate) return gate;
  const ref = String(args.recommendation ?? args.id ?? '').trim();

  try {
    // No status filter — the user may ask "why did you suggest that?" about
    // an already-activated or snoozed recommendation too.
    const resolved = await resolveRecommendation(sb, id, ref, null, 'explain_recommendation');
    if (!resolved.ok) return resolved.res;
    const rec = resolved.rec;

    const bits: string[] = [];
    if (rec.summary) bits.push(rec.summary);

    // Pillar contributions (contribution_vector JSONB, populated by trigger
    // from source_ref — 20260423150000_vitana_index_contribution_vector.sql).
    const cv = rec.contribution_vector;
    if (cv && typeof cv === 'object') {
      const pairs = Object.entries(cv)
        .filter(([k, v]) => PILLAR_KEYS.includes(k) && typeof v === 'number' && v > 0)
        .sort((a, b) => b[1] - a[1]);
      if (pairs.length > 0) {
        bits.push(`It mainly strengthens your ${pairs.slice(0, 2).map(([k]) => k).join(' and ')} pillar${pairs.length > 1 ? 's' : ''}.`);
      }
    }

    if (typeof rec.impact_score === 'number' && typeof rec.effort_score === 'number') {
      const impact = rec.impact_score >= 8 ? 'high' : rec.impact_score >= 5 ? 'solid' : 'modest';
      const effort = rec.effort_score <= 3 ? 'low' : rec.effort_score <= 6 ? 'moderate' : 'higher';
      bits.push(`Expected impact is ${impact} (${rec.impact_score}/10) for ${effort} effort (${rec.effort_score}/10).`);
    }
    if (rec.economic_axis && rec.economic_axis !== 'none') {
      bits.push(`It also advances the "${rec.economic_axis.replace(/_/g, ' ')}" axis of your longevity economy.`);
    }
    if (rec.source_type) {
      bits.push(`Source: ${rec.source_type.replace(/_/g, ' ')}${rec.domain ? `, domain ${rec.domain}` : ''}.`);
    } else if (rec.domain) {
      bits.push(`Domain: ${rec.domain}.`);
    }

    const title = rec.title ?? 'This recommendation';
    return {
      ok: true,
      result: {
        id: rec.id,
        title: rec.title,
        summary: rec.summary,
        domain: rec.domain,
        risk_level: rec.risk_level,
        impact_score: rec.impact_score,
        effort_score: rec.effort_score,
        contribution_vector: cv ?? null,
        source_type: rec.source_type ?? null,
        economic_axis: rec.economic_axis ?? null,
        status: rec.status,
      },
      text: `Why "${title}": ${bits.join(' ')} Offer to activate, snooze, or dismiss it.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'explain_recommendation failed' };
  }
}

// ---------------------------------------------------------------------------
// Intent management (VTID-02777)
// ---------------------------------------------------------------------------

interface IntentRow {
  intent_id: string;
  intent_kind: string | null;
  category: string | null;
  title: string | null;
  scope: string | null;
  status: string | null;
  created_at: string | null;
}

const ACTIVE_INTENT_STATUSES = ['open', 'matched', 'engaged'];

type IntentResolution =
  | { ok: true; intent: IntentRow }
  | { ok: false; res: OrbToolResult };

/** Resolve a spoken intent reference (UUID or title fragment) to ONE of the user's own active intents. */
async function resolveMyIntent(
  sb: SupabaseClient,
  id: OrbToolIdentity,
  ref: string,
  toolName: string,
): Promise<IntentResolution> {
  const COLS = 'intent_id, intent_kind, category, title, scope, status, created_at';
  if (UUID_RX.test(ref)) {
    const { data, error } = await sb
      .from('user_intents')
      .select(COLS)
      .eq('intent_id', ref)
      .eq('requester_user_id', id.user_id)
      .maybeSingle();
    if (error) return { ok: false, res: { ok: false, error: `${toolName}: ${error.message}` } };
    const intent = data as IntentRow | null;
    if (!intent) {
      return {
        ok: false,
        res: {
          ok: true,
          result: { found: false },
          text: 'I could not find that post among the user\'s own posts. Offer to list their posts so they can pick one.',
        },
      };
    }
    return { ok: true, intent };
  }

  let q = sb
    .from('user_intents')
    .select(COLS)
    .eq('requester_user_id', id.user_id)
    .in('status', ACTIVE_INTENT_STATUSES)
    .order('created_at', { ascending: false })
    .limit(5);
  if (ref) {
    const safe = orSafe(ref);
    q = q.or(`title.ilike.*${safe}*,scope.ilike.*${safe}*,category.ilike.*${safe}*`);
  }
  const { data, error } = await q;
  if (error) return { ok: false, res: { ok: false, error: `${toolName}: ${error.message}` } };
  const rows = (data as IntentRow[] | null) ?? [];
  if (rows.length === 0) {
    return {
      ok: false,
      res: {
        ok: true,
        result: { found: false, query: ref },
        text: ref
          ? `None of the user's open posts matched "${ref}". Offer to list their posts so they can pick one.`
          : 'The user has no open posts right now. Say so plainly and offer to create one.',
      },
    };
  }
  if (rows.length > 1) {
    const titles = rows.slice(0, 3).map((r) => `"${r.title ?? 'untitled'}"`);
    return {
      ok: false,
      res: {
        ok: true,
        result: {
          ambiguous: true,
          candidates: rows.slice(0, 3).map((r) => ({ intent_id: r.intent_id, title: r.title })),
        },
        text: `Several of the user's posts match: ${titles.join(', ')}. Ask which one they mean, then call ${toolName} again with its intent id.`,
      },
    };
  }
  return { ok: true, intent: rows[0] };
}

export async function tool_update_intent(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('update_intent', id);
  if (gate) return gate;
  const ref = String(args.intent ?? args.intent_id ?? '').trim();

  // Same allowed-field subset as PATCH /api/v1/intents/:id (owner only).
  const patch: Record<string, unknown> = {};
  const newTitle = String(args.new_title ?? '').trim();
  const newText = String(args.new_text ?? args.new_scope ?? '').trim();
  const newCategory = String(args.new_category ?? '').trim();
  if (newTitle) patch.title = newTitle;
  if (newText) patch.scope = newText;
  if (newCategory) patch.category = newCategory;
  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      error: 'update_intent needs at least one change: new_title, new_text, or new_category. Ask the user what they want to change.',
    };
  }

  try {
    const resolved = await resolveMyIntent(sb, id, ref, 'update_intent');
    if (!resolved.ok) return resolved.res;
    const intent = resolved.intent;

    const { data, error } = await sb
      .from('user_intents')
      .update(patch)
      .eq('intent_id', intent.intent_id)
      .eq('requester_user_id', id.user_id)
      .select('intent_id, title, scope, category')
      .maybeSingle();
    if (error) return { ok: false, error: `update_intent: ${error.message}` };
    if (!data) return { ok: false, error: 'not_found_or_not_owner' };
    const updated = data as { intent_id: string; title: string | null; scope: string | null; category: string | null };

    const changed: string[] = [];
    if (patch.title) changed.push(`title is now "${updated.title}"`);
    if (patch.scope) changed.push(`description is now "${snippet(updated.scope, 120)}"`);
    if (patch.category) changed.push(`category is now ${updated.category}`);
    return {
      ok: true,
      result: { intent_id: updated.intent_id, updated: patch },
      text: `Done — the post is updated: ${changed.join(', ')}.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'update_intent failed' };
  }
}

export async function tool_delete_intent(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('delete_intent', id);
  if (gate) return gate;
  const ref = String(args.intent ?? args.intent_id ?? '').trim();
  const confirmed = args.confirm === true;

  try {
    const resolved = await resolveMyIntent(sb, id, ref, 'delete_intent');
    if (!resolved.ok) return resolved.res;
    const intent = resolved.intent;
    const title = intent.title ?? 'that post';

    if (!confirmed) {
      return {
        ok: true,
        result: { stage: 'awaiting_confirmation', intent_id: intent.intent_id, title: intent.title },
        text: `Confirm with the user first: take down the post "${title}"? It will disappear from the board and matching stops. On a clear yes, call delete_intent again with intent="${intent.intent_id}" and confirm=true.`,
      };
    }

    // The platform's removal path is status='closed' (POST /intents/:id/close);
    // there is no hard-delete for user_intents.
    const { data, error } = await sb
      .from('user_intents')
      .update({ status: 'closed' })
      .eq('intent_id', intent.intent_id)
      .eq('requester_user_id', id.user_id)
      .select('intent_id')
      .maybeSingle();
    if (error) return { ok: false, error: `delete_intent: ${error.message}` };
    if (!data) return { ok: false, error: 'not_found_or_not_owner' };

    return {
      ok: true,
      result: { intent_id: intent.intent_id, title: intent.title, status: 'closed' },
      text: `Done — "${title}" is taken down from the board. The user can always post it again later.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'delete_intent failed' };
  }
}

const KIND_LABELS: Record<string, string> = {
  activity_seek: 'activity partner wanted',
  social_seek: 'looking to connect',
  commercial_buy: 'looking to buy',
  commercial_sell: 'offering',
  mutual_aid: 'help exchange',
};

export async function tool_browse_intent_board(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('browse_intent_board', id, true);
  if (gate) return gate;
  const query = String(args.query ?? '').trim();
  const limit = clampInt(args.limit, 1, 10, 5);

  try {
    // Mirrors GET /api/v1/intent-board: tenant-scoped, open only, never the
    // user's own posts, partner_seek excluded on the default surface.
    let q = sb
      .from('user_intents')
      .select('intent_id, intent_kind, category, title, scope, created_at')
      .eq('tenant_id', id.tenant_id)
      .eq('status', 'open')
      .neq('requester_user_id', id.user_id)
      .neq('intent_kind', 'partner_seek')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (query) {
      const safe = orSafe(query);
      q = q.or(`title.ilike.*${safe}*,scope.ilike.*${safe}*,category.ilike.*${safe}*`);
    }
    const { data, error } = await q;
    if (error) return { ok: false, error: `browse_intent_board: ${error.message}` };
    const rows = (data as IntentRow[] | null) ?? [];

    if (rows.length === 0) {
      return {
        ok: true,
        result: { query: query || null, intents: [] },
        text: query
          ? `No open asks on the board matched "${query}". Offer to browse the whole board or post the user's own ask.`
          : 'The intent board has no open asks right now. Warmly suggest the user posts the first one — you can set it up by voice.',
      };
    }

    const lines = rows.map((r) => {
      const kind = KIND_LABELS[r.intent_kind ?? ''] ?? (r.intent_kind ?? 'ask');
      return `"${r.title ?? 'untitled'}" (${kind}${r.created_at ? `, ${timeAgo(r.created_at)}` : ''})`;
    });
    return {
      ok: true,
      result: { query: query || null, intents: rows },
      text:
        `${rows.length} open ask${rows.length === 1 ? '' : 's'} on the community board${query ? ` matching "${query}"` : ''}: ` +
        `${lines.join('; ')}. Present the top ones and offer to respond to one or post the user's own.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'browse_intent_board failed' };
  }
}

// ---------------------------------------------------------------------------
// dispute_match — open a dispute on a match (VTID-02780, reuses VTID-01976)
// ---------------------------------------------------------------------------

const DISPUTE_CATEGORIES = ['no_show', 'misrepresented', 'safety', 'payment', 'other'] as const;
type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

function normalizeDisputeCategory(raw: unknown): DisputeCategory {
  const v = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (DISPUTE_CATEGORIES as readonly string[]).includes(v) ? (v as DisputeCategory) : 'other';
}

export async function tool_dispute_match(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('dispute_match', id);
  if (gate) return gate;
  let matchId = String(args.match_id ?? '').trim();
  const reason = String(args.reason ?? '').trim();
  const category = normalizeDisputeCategory(args.reason_category);
  const confirmed = args.confirm === true;

  try {
    // No match named → look across the user's own intents' matches; only
    // auto-pick when it is unambiguous (exactly one recent match).
    if (!matchId) {
      const { data: myIntents, error: intErr } = await sb
        .from('user_intents')
        .select('intent_id')
        .eq('requester_user_id', id.user_id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (intErr) return { ok: false, error: `dispute_match: ${intErr.message}` };
      const intentIds = ((myIntents as Array<{ intent_id: string }> | null) ?? []).map((r) => r.intent_id);
      if (intentIds.length === 0) {
        return {
          ok: true,
          result: { found: false },
          text: 'The user has no posts, so there is no match to dispute. Ask what happened — maybe this is general feedback instead.',
        };
      }
      const list = intentIds.join(',');
      const { data: matches, error: mErr } = await sb
        .from('intent_matches')
        .select('match_id, intent_a_id, intent_b_id, state, created_at')
        .or(`intent_a_id.in.(${list}),intent_b_id.in.(${list})`)
        .order('created_at', { ascending: false })
        .limit(5);
      if (mErr) return { ok: false, error: `dispute_match: ${mErr.message}` };
      const rows = (matches as Array<{ match_id: string; state: string | null; created_at: string | null }> | null) ?? [];
      if (rows.length === 0) {
        return {
          ok: true,
          result: { found: false },
          text: 'The user has no matches yet, so there is nothing to dispute. Ask what happened — maybe this is general feedback instead.',
        };
      }
      if (rows.length > 1) {
        const opts = rows.slice(0, 3).map((r) => `${r.match_id} (${r.state ?? 'unknown'}, ${timeAgo(r.created_at)})`);
        return {
          ok: true,
          result: { ambiguous: true, candidates: rows.slice(0, 3) },
          text: `The user has several matches: ${opts.join('; ')}. Ask which match this is about (or open My Matches with view_intent_matches), then call dispute_match again with match_id.`,
        };
      }
      matchId = rows[0].match_id;
    }

    if (!reason) {
      return {
        ok: true,
        result: { stage: 'needs_reason', match_id: matchId },
        text: 'Ask the user in one warm sentence what went wrong with this match (no-show, misrepresented, safety, payment, or something else), then call dispute_match again with match_id, reason, and reason_category.',
      };
    }

    if (!confirmed) {
      return {
        ok: true,
        result: { stage: 'awaiting_confirmation', match_id: matchId, reason, reason_category: category },
        text: `Read this back and confirm before filing: open a dispute on this match because "${reason}" (category: ${category.replace(/_/g, ' ')}). The other member and our team will review it. On a clear yes, call dispute_match again with confirm=true.`,
      };
    }

    // Canonical dispute path (VTID-01976): verifies the raiser is a party on
    // the match, denormalises vitana_ids, emits OASIS audit + admin notify.
    const { raiseDispute } = await import('../intent-dispute-service');
    const dispute = await raiseDispute({
      match_id: matchId,
      raised_by: id.user_id,
      reason_category: category,
      reason_detail: reason,
      vitana_id_hint: id.vitana_id ?? null,
    });

    return {
      ok: true,
      result: { dispute_id: dispute.dispute_id, match_id: matchId, status: dispute.status },
      text: 'The dispute is filed — our team will review it and follow up. Reassure the user their report is logged and they can add details any time from the match page.',
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'dispute_match failed';
    if (msg === 'match_not_found') {
      return {
        ok: true,
        result: { found: false },
        text: 'I could not find that match. Offer to open My Matches (view_intent_matches) so the user can point at the right one.',
      };
    }
    if (msg === 'not_a_party') {
      return { ok: false, error: 'dispute_match: the user is not a participant of that match.' };
    }
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// find_perfect_match — flagship people-match search (VTID-02780)
// ---------------------------------------------------------------------------

/** Weakest pillar → a sensible default people-ask when the user is vague. */
const PILLAR_DEFAULT_ASK: Record<string, string> = {
  exercise: 'a workout partner to train with regularly',
  sleep: 'an accountability partner for a better evening and sleep routine',
  nutrition: 'a healthy-cooking and nutrition buddy',
  hydration: 'an accountability buddy for daily healthy habits',
  mental: 'a mindfulness or meditation partner',
};

export async function tool_find_perfect_match(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const gate = authGate('find_perfect_match', id);
  if (gate) return gate;
  let ask = String(args.ask ?? args.utterance ?? args.query ?? '').trim();

  try {
    // Fusion inputs — same pair find_perfect_product/practitioner use.
    const ctx = await getCompassAndWeakestPillar(sb, id.user_id);

    let derivedFromPillar = false;
    if (!ask) {
      if (ctx.weakest_pillar && PILLAR_DEFAULT_ASK[ctx.weakest_pillar]) {
        ask = PILLAR_DEFAULT_ASK[ctx.weakest_pillar];
        derivedFromPillar = true;
      } else {
        return {
          ok: true,
          result: { stage: 'needs_ask' },
          text: 'Ask the user in one warm sentence what kind of person they are looking for — a workout partner, an accountability buddy, a mentor, someone to learn with — then call find_perfect_match again with their answer as ask.',
        };
      }
    }

    // REUSE the find_match engine (BOOTSTRAP-FIND-MATCH-VOICE): classify +
    // extract + search the live intent catalog, recommend existing people,
    // and post the request (with confirm flow) so the user is discoverable.
    const { runFindMatch } = await import('../intent-find-match');
    const r = await runFindMatch(
      { utterance: ask, kind_hint: args.kind_hint, confirmed: args.confirmed },
      {
        user_id: id.user_id,
        tenant_id: id.tenant_id ?? null,
        vitana_id: id.vitana_id ?? null,
        session_id: id.session_id ?? null,
      },
    );
    if (!r.ok) return { ok: false, error: r.error ?? 'find_perfect_match failed' };

    const personalBits: string[] = [];
    if (ctx.compass_goal) personalBits.push(`the user's Life Compass goal "${ctx.compass_goal}"`);
    if (ctx.weakest_pillar) personalBits.push(`their ${ctx.weakest_pillar} pillar (currently their weakest)`);
    const prefix =
      personalBits.length > 0
        ? `PERSONALIZATION — this people-search is aligned with ${personalBits.join(' and ')}${derivedFromPillar ? `; the ask "${ask}" was suggested from that pillar` : ''}. Mention this in one natural sentence. `
        : '';

    return {
      ok: true,
      result: {
        ...r.data,
        stage: r.stage,
        ask,
        ask_derived_from_pillar: derivedFromPillar,
        compass_goal: ctx.compass_goal,
        compass_category: ctx.compass_category,
        weakest_pillar: ctx.weakest_pillar,
      },
      text: prefix + r.text,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'find_perfect_match failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const DISCOVERY_TOOL_HANDLERS: Record<string, Handler> = {
  global_search: tool_global_search,
  browse_news_feed: tool_browse_news_feed,
  snooze_recommendation: tool_snooze_recommendation,
  dismiss_recommendation: tool_dismiss_recommendation,
  explain_recommendation: tool_explain_recommendation,
  update_intent: tool_update_intent,
  delete_intent: tool_delete_intent,
  browse_intent_board: tool_browse_intent_board,
  dispute_match: tool_dispute_match,
  find_perfect_match: tool_find_perfect_match,
};

export const DISCOVERY_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'global_search',
    description: [
      'Unified community search across people, posts, events, groups, products,',
      'and services in one call. Returns the top hits per category.',
      'CALL WHEN the user asks a broad "find/search" question: "search for yoga",',
      '"find anything about fasting", "such nach Tennis", "gibt es was zu Schlaf?".',
      'For a specific person prefer find_community_member; for events only,',
      'search_events. After the tool runs, present the most relevant category',
      'first — top two or three hits, never the raw list.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the user is looking for, verbatim.' },
        limit: { type: 'number', description: 'Max hits per category, 1-5. Omit for 3.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browse_news_feed',
    description: [
      'Read the community news feed aloud: recent posts with author and a',
      'one-line summary. scope "following" limits to people the user follows;',
      '"all" is the whole community (default).',
      'CALL WHEN the user asks: "what\'s new in the community?", "read me the',
      'feed", "was gibt es Neues?", "zeig mir die Neuigkeiten von Leuten denen',
      'ich folge". After the tool runs, speak each post as author plus a short',
      'summary — never read long posts word for word.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many posts to read, 1-10. Omit for 5.' },
        scope: {
          type: 'string',
          enum: ['following', 'all'],
          description: '"following" = only people the user follows; "all" = whole community (default).',
        },
      },
      required: [],
    },
  },
  {
    name: 'snooze_recommendation',
    description: [
      'Snooze an Autopilot recommendation so it resurfaces later (default 24h,',
      'max one week). Accepts the recommendation id or a spoken title fragment.',
      'CALL WHEN the user says: "remind me about that later", "snooze the sleep',
      'recommendation", "später erinnern", "leg das auf Wiedervorlage".',
      'After the tool runs, confirm the title and when it will come back.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        recommendation: { type: 'string', description: 'Recommendation id (UUID) or a title fragment the user said.' },
        hours: { type: 'number', description: 'Hours to snooze, 1-168. Omit for 24.' },
      },
      required: ['recommendation'],
    },
  },
  {
    name: 'dismiss_recommendation',
    description: [
      'Dismiss an Autopilot recommendation for good (it will not come back).',
      'TWO-STEP: first call returns a confirmation question — read it back;',
      'only after a clear yes call again with confirm=true.',
      'CALL WHEN the user says: "not interested", "dismiss that suggestion",',
      '"das interessiert mich nicht", "weg damit".',
      'If the user just wants it later, use snooze_recommendation instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        recommendation: { type: 'string', description: 'Recommendation id (UUID) or a title fragment the user said.' },
        reason: { type: 'string', description: 'OPTIONAL — why the user dismisses it, in their words.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user verbally confirmed the dismissal.' },
      },
      required: ['recommendation'],
    },
  },
  {
    name: 'explain_recommendation',
    description: [
      'Explain WHY a specific Autopilot recommendation was suggested: its',
      'rationale, which Vitana pillars it strengthens, impact vs effort, and',
      'where it came from. Accepts an id or a spoken title fragment.',
      'CALL WHEN the user asks: "why are you suggesting this?", "what\'s that',
      'recommendation about?", "warum schlägst du mir das vor?", "was bringt',
      'mir das?". After the tool runs, narrate the reason in 2-3 sentences and',
      'offer to activate, snooze, or dismiss it.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        recommendation: { type: 'string', description: 'Recommendation id (UUID) or a title fragment the user said.' },
      },
      required: ['recommendation'],
    },
  },
  {
    name: 'update_intent',
    description: [
      'Edit one of the user\'s OWN intent posts (title, description text, or',
      'category). Accepts the intent id or a spoken title fragment.',
      'CALL WHEN the user says: "change my tennis post to say weekends only",',
      '"update the title of my ask", "ändere meinen Beitrag", "mach aus meinem',
      'Post ...". Pass ONLY the fields that change. After the tool runs,',
      'confirm what was updated in one sentence.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Intent id (UUID) or a title fragment identifying the user\'s post.' },
        new_title: { type: 'string', description: 'OPTIONAL — the new title.' },
        new_text: { type: 'string', description: 'OPTIONAL — the new description / scope text.' },
        new_category: { type: 'string', description: 'OPTIONAL — the new dotted category, e.g. sport.tennis.' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'delete_intent',
    description: [
      'Take down one of the user\'s OWN intent posts from the board (closes it;',
      'matching stops). TWO-STEP: first call returns a confirmation question —',
      'read it back; only after a clear yes call again with confirm=true.',
      'CALL WHEN the user says: "delete my post", "remove my tennis ask",',
      '"lösch meinen Beitrag", "nimm das vom Brett".',
      'If the ask was fulfilled, prefer mark_intent_fulfilled instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Intent id (UUID) or a title fragment identifying the user\'s post.' },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user verbally confirmed the removal.' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'browse_intent_board',
    description: [
      'Browse the open community intent board (Open Asks): what other members',
      'are looking for, buying, selling, or offering right now. Optional query',
      'filters by topic. Never shows the user\'s own posts.',
      'CALL WHEN the user asks: "what are people looking for?", "browse the',
      'asks board", "was suchen andere gerade?", "zeig mir das Schwarze Brett".',
      'After the tool runs, present the top asks (title + kind) and offer to',
      'respond to one or post the user\'s own ask.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'OPTIONAL — topic filter, e.g. "tennis" or "babysitting".' },
        limit: { type: 'number', description: 'Max asks to return, 1-10. Omit for 5.' },
      },
      required: [],
    },
  },
  {
    name: 'dispute_match',
    description: [
      'Open a dispute on a match the user is part of (no-show, misrepresented,',
      'safety, payment, other). MULTI-STEP: the tool first collects the reason,',
      'then returns a confirmation question — only after a clear yes call again',
      'with confirm=true. CALL WHEN the user says: "the seller never showed up",',
      '"I want to report this match", "der Kontakt war fake", "ich möchte das',
      'Match melden". Stay neutral and factual — never promise an outcome.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        match_id: { type: 'string', description: 'The match id if known. Omit to auto-detect from the user\'s recent matches.' },
        reason: { type: 'string', description: 'What happened, in the user\'s words.' },
        reason_category: {
          type: 'string',
          enum: ['no_show', 'misrepresented', 'safety', 'payment', 'other'],
          description: 'Best-fitting category for what happened.',
        },
        confirm: { type: 'boolean', description: 'Pass true ONLY after the user verbally confirmed filing the dispute.' },
      },
      required: [],
    },
  },
  {
    name: 'find_perfect_match',
    description: [
      'Flagship people-match: find the PERFECT person for the user — workout',
      'partner, accountability buddy, mentor, learning partner — personalized',
      'with their Life Compass goal and weakest Vitana pillar. Searches the',
      'live community asks and, per the confirm flow, also posts the request',
      'so the user becomes discoverable.',
      'CALL WHEN the user says: "find me a workout partner", "who would be my',
      'perfect accountability buddy?", "find den perfekten Trainingspartner',
      'für mich", "such mir einen Mentor".',
      'Follow the returned text exactly — it tells you whether matches were',
      'found or a read-back confirmation is needed (then call again with',
      'confirmed=true).',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        ask: { type: 'string', description: 'What kind of person the user wants, verbatim. May be omitted — then the weakest pillar suggests one.' },
        kind_hint: { type: 'string', description: 'OPTIONAL intent kind hint, e.g. activity_seek or social_seek.' },
        confirmed: { type: 'boolean', description: 'Pass true ONLY after the user confirmed posting the request (second call).' },
      },
      required: [],
    },
  },
];
