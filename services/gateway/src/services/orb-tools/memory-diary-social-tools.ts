/**
 * Community voice tools — Memory & Diary extras (A13) + Profile & Social
 * depth (A14), Wave 6 (final wave) of docs/VOICE_TOOLS_EXPANSION_PLAN.md.
 *
 * A13: `archive_memory` and `promote_memory_to_knowledge` are SKIPPED.
 * `archive_memory`'s only two candidate backends are dishonest to ship: the
 * `POST /api/v1/memory/lock` route writes to `memory_locks`, but no
 * retrieval/context/timeline code anywhere reads that table, so "locking" a
 * memory currently has zero visible effect; and `DELETE /api/v1/memory/entity`
 * is a real, permanent-ish cascade delete (`memory_delete_entity` RPC), not a
 * reversible "soft-hide" — presenting either as "archive" would misrepresent
 * what the action does. `promote_memory_to_knowledge` has no route at all:
 * the only Knowledge Hub write surface is the tenant-admin KB CMS
 * (requireTenantAdmin), with nothing linking a memory_items row into it.
 * `reinforce_memory` maps to the real confidence-confirm RPC (raises trust,
 * not a separate "importance" field — the tool is honest about this in its
 * spoken text). `get_what_vitana_knows` is a thin alias of the already-built
 * `get_memory_garden_summary` tool (same underlying function).
 *
 * A14: `set_profile_theme` is SKIPPED — identical gap to the already-built
 * `set_theme` tool (no `profiles.theme` column exists anywhere); building a
 * second tool with the same non-functional outcome would be redundant.
 * `add_gallery_photo` and `list_member_posts` are SKIPPED — no gallery/photo
 * table and no posts/feed table exist anywhere in the schema.
 * `get_profile_completeness` is scoped to the real, existing taste/lifestyle
 * completeness score (`taste_alignment_bundle_get` RPC) — there is no
 * separate "general profile fields" completeness anywhere; the tool's
 * spoken text is explicit about this narrower scope.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { tool_get_memory_garden_summary } from './diary-memory-tools';
import { gatewayApiCall, clampLimit } from './developer-tools';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

function authHeaders(id: OrbToolIdentity): Record<string, string> {
  return id.user_jwt ? { Authorization: `Bearer ${id.user_jwt}` } : {};
}

const NO_SESSION: OrbToolResult = {
  ok: true,
  result: { reason: 'no_session' },
  text: "I need your signed-in session to do that — I don't have one for this voice session.",
};

// ---------------------------------------------------------------------------
// A13.1 edit_memory — POST /api/v1/memory/confidence/correct
// ---------------------------------------------------------------------------

export const edit_memory: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'edit_memory requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const memoryItemId = String(args.memory_item_id ?? '').trim();
  const newContent = typeof args.new_content === 'string' ? args.new_content.trim() : undefined;
  if (!memoryItemId || !newContent) return { ok: false, error: 'edit_memory requires memory_item_id and new_content.' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, memory_item_id: memoryItemId, new_content: newContent },
      text: `About to correct that memory to: "${newContent}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/memory/confidence/correct', {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      memory_item_id: memoryItemId,
      new_content: newContent,
      correction_notes: typeof args.correction_notes === 'string' ? args.correction_notes : 'Corrected via voice',
    },
  });
  if (!ok) return { ok: true, result: { corrected: false, status, detail: body }, text: `Could not correct that memory: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { corrected: true, detail: body }, text: `Memory corrected.` };
};

// ---------------------------------------------------------------------------
// A13.3 reinforce_memory — POST /api/v1/memory/confidence/confirm
// (raises confidence/trust — there's no separate "importance" field)
// ---------------------------------------------------------------------------

export const reinforce_memory: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'reinforce_memory requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const memoryItemId = String(args.memory_item_id ?? '').trim();
  if (!memoryItemId) return { ok: false, error: 'reinforce_memory requires memory_item_id.' };
  const { ok, status, body } = await gatewayApiCall('/api/v1/memory/confidence/confirm', {
    method: 'POST',
    headers: authHeaders(id),
    body: {
      memory_item_id: memoryItemId,
      confirmation_notes: typeof args.confirmation_notes === 'string' ? args.confirmation_notes : 'Confirmed via voice',
    },
  });
  if (!ok) return { ok: true, result: { confirmed: false, status, detail: body }, text: `Could not confirm that memory: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { confirmed: true, detail: body }, text: `Got it — I've marked that memory as confirmed and trustworthy.` };
};

// ---------------------------------------------------------------------------
// A13.5 set_memory_permissions — POST /api/v1/memory/settings/visibility
// ---------------------------------------------------------------------------

const MEMORY_DOMAINS = ['diary', 'garden', 'relationships', 'longevity', 'timeline'];
const MEMORY_VISIBILITIES = ['private', 'connections', 'professionals', 'custom'];

export const set_memory_permissions: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'set_memory_permissions requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const domain = String(args.domain ?? '').trim();
  const visibility = String(args.visibility ?? '').trim();
  if (!MEMORY_DOMAINS.includes(domain) || !MEMORY_VISIBILITIES.includes(visibility)) {
    return { ok: false, error: `set_memory_permissions requires domain (${MEMORY_DOMAINS.join(', ')}) and visibility (${MEMORY_VISIBILITIES.join(', ')}).` };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, domain, visibility },
      text: `About to set your "${domain}" memory visibility to "${visibility}". Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/memory/settings/visibility', {
    method: 'POST',
    headers: authHeaders(id),
    body: { domain, visibility, custom_rules: typeof args.custom_rules === 'object' ? args.custom_rules : undefined },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update that setting: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Your "${domain}" memory visibility is now "${visibility}".` };
};

// ---------------------------------------------------------------------------
// A13.6 get_what_vitana_knows — alias of get_memory_garden_summary
// ---------------------------------------------------------------------------

export const get_what_vitana_knows: Handler = async (args, id, sb) => tool_get_memory_garden_summary(args, id, sb);

// ---------------------------------------------------------------------------
// A13.7 add_diary_photo — navigation-only (no photo/media storage exists)
// ---------------------------------------------------------------------------

export const add_diary_photo: Handler = async (args, id, sb) => {
  // Dynamic import (not a static one) — orb-tools-shared.ts imports this
  // module's declarations, so a static import back would create a load-order
  // cycle. Resolving lazily at call time sidesteps it.
  const { tool_navigate_to_screen } = await import('../orb-tools-shared');
  return tool_navigate_to_screen({ ...args, screen_id: 'MEMORY.DIARY' }, id, sb);
};

// ---------------------------------------------------------------------------
// A14.2 get_profile_completeness — GET /api/v1/taste-alignment/bundle
// (scoped to the real taste/lifestyle completeness score)
// ---------------------------------------------------------------------------

export const get_profile_completeness: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'get_profile_completeness requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const { ok, status, body } = await gatewayApiCall('/api/v1/taste-alignment/bundle', { headers: authHeaders(id) });
  if (!ok) return { ok: false, error: `get_profile_completeness failed (${status}): ${String(body.error ?? 'unknown')}` };
  const bundle = (body.bundle ?? {}) as Record<string, unknown>;
  const pct = Number(bundle.profile_completeness ?? 0);
  return {
    ok: true,
    result: bundle,
    text: `Your taste and lifestyle profile is ${pct}% complete${bundle.sparse_data ? ' — add a few more preferences for better matches' : ''}.`,
  };
};

// ---------------------------------------------------------------------------
// A14.4 share_my_profile — GET /api/v1/public/profile/:id (public route)
// ---------------------------------------------------------------------------

export const share_my_profile: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'share_my_profile requires an authenticated user.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/public/profile/${encodeURIComponent(id.user_id)}`);
  if (!ok) return { ok: false, error: `share_my_profile failed (${status}): ${String(body.error ?? 'unknown')}` };
  const profile = (body.profile ?? {}) as Record<string, unknown>;
  const handle = typeof profile.handle === 'string' && profile.handle ? profile.handle : id.user_id;
  const url = `https://vitanaland.com/u/${handle}`;
  return { ok: true, result: { profile, share_url: url }, text: `Your profile link: ${url}` };
};

// ---------------------------------------------------------------------------
// A14.5 get_my_milestones — direct Supabase read (autopilot_recommendations)
// ---------------------------------------------------------------------------

export const get_my_milestones: Handler = async (args, id, sb) => {
  if (!id.user_id) return { ok: false, error: 'get_my_milestones requires an authenticated user.' };
  const limit = clampLimit(args.limit, 20, 100);
  const { data, error } = await sb
    .from('autopilot_recommendations')
    .select('source_ref, title, summary, impact_score, created_at')
    .eq('user_id', id.user_id)
    .eq('source_type', 'milestone')
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { ok: false, error: `get_my_milestones failed: ${error.message}` };
  const milestones = (data ?? []) as Array<{ title?: string }>;
  if (milestones.length === 0) return { ok: true, result: { milestones: [] }, text: 'No milestones achieved yet.' };
  return { ok: true, result: { milestones }, text: `${milestones.length} milestones: ${milestones.slice(0, 8).map((m) => m.title).join(', ')}.` };
};

// ---------------------------------------------------------------------------
// A14.6 view_member_profile — GET /api/v1/public/profile/:id (public route)
// ---------------------------------------------------------------------------

export const view_member_profile: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'view_member_profile requires an authenticated user.' };
  const targetId = String(args.user_id ?? args.handle ?? '').trim();
  if (!targetId) return { ok: false, error: 'view_member_profile requires user_id or handle.' };
  const { ok, status, body } = await gatewayApiCall(`/api/v1/public/profile/${encodeURIComponent(targetId)}`);
  if (!ok) {
    return status === 404
      ? { ok: true, result: { found: false }, text: `I couldn't find a member matching "${targetId}".` }
      : { ok: false, error: `view_member_profile failed (${status}): ${String(body.error ?? 'unknown')}` };
  }
  const profile = (body.profile ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    result: profile,
    text: `${String(profile.display_name ?? profile.first_name ?? targetId)}${profile.longevity_archetype ? ` — ${String(profile.longevity_archetype)} archetype` : ''}${profile.bio ? `. ${String(profile.bio)}` : ''}`,
  };
};

// ---------------------------------------------------------------------------
// A14.8 update_service_offerings — PATCH /api/v1/profiles/me/service-offerings
// (profiles.service_offerings — distinct from services_catalog/create_service)
// ---------------------------------------------------------------------------

export const update_service_offerings: Handler = async (args, id) => {
  if (!id.user_id) return { ok: false, error: 'update_service_offerings requires an authenticated user.' };
  if (!id.user_jwt) return NO_SESSION;
  const offers = Array.isArray(args.offers) ? args.offers : [];
  if (offers.length === 0) return { ok: false, error: 'update_service_offerings requires a non-empty offers array (each with category and title).' };
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, offer_count: offers.length },
      text: `About to replace your profile service offerings with ${offers.length} entries. Confirm, then call again with confirm=true.`,
    };
  }
  const { ok, status, body } = await gatewayApiCall('/api/v1/profiles/me/service-offerings', {
    method: 'PATCH',
    headers: authHeaders(id),
    body: { offers },
  });
  if (!ok) return { ok: true, result: { updated: false, status, detail: body }, text: `Could not update your service offerings: ${String(body.error ?? `gateway returned ${status}`)}.` };
  return { ok: true, result: { updated: true, detail: body }, text: `Profile service offerings updated.` };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const MEMORY_DIARY_SOCIAL_TOOL_HANDLERS: Record<string, Handler> = {
  edit_memory,
  reinforce_memory,
  set_memory_permissions,
  get_what_vitana_knows,
  add_diary_photo,
  get_profile_completeness,
  share_my_profile,
  get_my_milestones,
  view_member_profile,
  update_service_offerings,
};

export const MEMORY_DIARY_SOCIAL_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'edit_memory',
    description: 'Correct the content of a stored memory. TWO-STEP confirm.',
    parameters: { type: 'object', properties: { memory_item_id: { type: 'string', description: 'Required.' }, new_content: { type: 'string', description: 'Required.' }, correction_notes: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['memory_item_id', 'new_content'] },
  },
  { name: 'reinforce_memory', description: 'Confirm a memory as accurate and trustworthy (raises its confidence score).', parameters: { type: 'object', properties: { memory_item_id: { type: 'string', description: 'Required.' }, confirmation_notes: { type: 'string' } }, required: ['memory_item_id'] } },
  {
    name: 'set_memory_permissions',
    description: 'Set who can see a category of your memory (diary, garden, relationships, longevity, timeline). TWO-STEP confirm.',
    parameters: { type: 'object', properties: { domain: { type: 'string', description: 'diary, garden, relationships, longevity, or timeline. Required.' }, visibility: { type: 'string', description: 'private, connections, professionals, or custom. Required.' }, confirm: { type: 'boolean' } }, required: ['domain', 'visibility'] },
  },
  { name: 'get_what_vitana_knows', description: '"What do you know about me" — summary of your memory garden by category.', parameters: { type: 'object', properties: {} } },
  { name: 'add_diary_photo', description: 'Opens the diary screen so you can attach a photo (voice cannot upload directly).', parameters: { type: 'object', properties: {} } },
  { name: 'get_profile_completeness', description: 'Your taste/lifestyle profile completeness percentage.', parameters: { type: 'object', properties: {} } },
  { name: 'share_my_profile', description: 'Get your shareable profile link.', parameters: { type: 'object', properties: {} } },
  { name: 'get_my_milestones', description: 'Your achieved milestones.', parameters: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'view_member_profile', description: "Spoken summary of a community member's public profile.", parameters: { type: 'object', properties: { user_id: { type: 'string' }, handle: { type: 'string' } } } },
  {
    name: 'update_service_offerings',
    description: 'Replace the service offerings shown on your profile. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        offers: {
          type: 'array',
          description: 'Required, replaces existing offerings. Each: {category, title, short_description?, price_min_cents?, price_max_cents?, currency?, contact_via?}.',
          items: { type: 'object', properties: { category: { type: 'string' }, title: { type: 'string' } } },
        },
        confirm: { type: 'boolean' },
      },
      required: ['offers'],
    },
  },
];
