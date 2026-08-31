/**
 * BOOTSTRAP-SOCIAL-MEMORY — community activity views.
 *
 * Two shapes:
 *   1. Person activity — "what did Mariia do recently?" — that person's
 *      recent VISIBLE actions (public posts, events joined/created).
 *   2. Network digest — "what changed in my community since yesterday?" —
 *      recent visible actions of the people the viewer follows/matches.
 *
 * Privacy: only public posts, only event participation in events the
 * platform lists publicly. Blocked/muted authors never appear.
 */

import { getSupabase } from '../../lib/supabase';
import { ActivityContext, ActivityItem, SocialPerson } from './social-memory-types';
import {
  fetchPersonById,
  fetchPersonPosts,
  fetchPeople,
  fetchEventTitles,
} from './social-memory-repository';
import * as repo from './community-activity-builder-repository';

/** Recent visible activity of ONE person. */
export async function buildPersonActivity(
  personId: string,
  windowDays = 14,
): Promise<ActivityContext> {
  const supabase = getSupabase();
  const person = await fetchPersonById(personId);
  const items: ActivityItem[] = [];
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();

  if (supabase && person) {
    const [posts, participations, groupJoins] = await Promise.all([
      fetchPersonPosts(personId, 5),
      repo.fetchPersonEventParticipations(supabase, personId, since, 5),
      repo.fetchPersonGroupJoins(supabase, personId, since, 5),
    ]);

    for (const p of posts) {
      if (Date.parse(p.created_at) < Date.parse(since)) continue;
      items.push({
        kind: 'post',
        at: p.created_at,
        summary: `Posted: "${(p.content || '').slice(0, 100)}"`,
        ref_id: p.id,
      });
    }

    const eventIds = (participations.data || []).map((r) => r.event_id);
    const eventTitles = await fetchEventTitles(eventIds);
    for (const r of participations.data || []) {
      items.push({
        kind: 'event_joined',
        at: r.registered_at,
        summary: `Joined event: ${eventTitles.get(r.event_id) || 'a community event'}`,
        ref_id: r.event_id,
      });
    }

    if ((groupJoins.data || []).length > 0) {
      const { data: groups } = await repo.fetchCommunityGroupNames(
        supabase,
        (groupJoins.data || []).map((g) => g.group_id),
      );
      const nameById = new Map((groups || []).map((g: any) => [g.id, g.name]));
      for (const g of groupJoins.data || []) {
        items.push({
          kind: 'group_joined',
          at: g.joined_at,
          summary: `Joined group: ${nameById.get(g.group_id) || 'a community group'}`,
          ref_id: g.group_id,
        });
      }
    }
  }

  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { person, items: items.slice(0, 10), window_days: windowDays };
}

/**
 * Network digest: recent visible posts + event joins from a set of
 * important people (followed + matched), for "what changed since yesterday".
 */
export async function buildNetworkDigest(
  importantPersonIds: string[],
  excludeIds: Set<string>,
  windowDays = 2,
): Promise<ActivityContext> {
  const supabase = getSupabase();
  const items: ActivityItem[] = [];
  const ids = importantPersonIds.filter((id) => !excludeIds.has(id)).slice(0, 40);
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();

  if (supabase && ids.length > 0) {
    const [posts, participations] = await Promise.all([
      repo.fetchNetworkVisiblePosts(supabase, ids, since, 15),
      repo.fetchNetworkEventParticipations(supabase, ids, since, 15),
    ]);

    const authorIds = new Set<string>([
      ...(posts.data || []).map((p) => p.user_id),
      ...(participations.data || []).map((p) => p.user_id),
    ]);
    const people = await fetchPeople(Array.from(authorIds));
    const nameOf = (id: string) =>
      people.get(id)?.display_name || people.get(id)?.handle || 'Someone you follow';

    for (const p of posts.data || []) {
      items.push({
        kind: 'post',
        at: p.created_at,
        summary: `${nameOf(p.user_id)} posted: "${(p.content || '').slice(0, 80)}"`,
        ref_id: p.id,
      });
    }
    const eventTitles = await fetchEventTitles(
      (participations.data || []).map((r) => r.event_id),
    );
    for (const r of participations.data || []) {
      items.push({
        kind: 'event_joined',
        at: r.registered_at,
        summary: `${nameOf(r.user_id)} joined ${eventTitles.get(r.event_id) || 'an event'}`,
        ref_id: r.event_id,
      });
    }
  }

  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { person: null, items: items.slice(0, 12), window_days: windowDays };
}
