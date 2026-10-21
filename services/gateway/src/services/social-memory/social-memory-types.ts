/**
 * BOOTSTRAP-SOCIAL-MEMORY — Social Memory Intelligence types.
 *
 * The Social Context Pack is the assistant's live picture of the user's
 * Maxina Community life: who they follow, who follows them, who they talk
 * to, their matches (with scores and reasons), their group chats, ranked
 * interesting posts/events, and — for person queries — a full Person
 * Intelligence view.
 *
 * Table ground truth (verified against the live database 2026-07-03):
 *   user_follows(follower_id, following_id, created_at)
 *   daily_matches(user_id, matched_user_id, match_score, match_reasons,
 *                 viewed_at, action, expires_at)
 *   user_matches(user_id_1, user_id_2, compatibility_score, match_reason,
 *                matched_at, conversation_started, is_active)
 *   chat_messages(sender_id, receiver_id, group_id, content, created_at)
 *   chat_groups(id, name, is_system) + chat_group_members(group_id, user_id)
 *   profile_posts(user_id, content, is_public, likes_count, comments_count,
 *                 image_url, video_url, moderation_status, created_at)
 *   global_community_events(id, title, event_type, start_time, location,
 *                           slug, participant_count)
 *   global_event_participants(event_id, user_id, status)
 *   global_community_groups / global_community_group_members
 *   user_interests(user_id, interest, confidence_score)
 *   user_blocked_authors / user_muted_authors / user_hidden_posts
 *   profiles(user_id, display_name, handle, avatar_url, bio, city, country,
 *            account_visibility, languages, vitana_id, ...)
 *   profile_privacy_settings(user_id, searchable, show_full_name, ...)
 */

// =============================================================================
// People
// =============================================================================

/** Privacy-safe public view of a person (never exposes email/phone/medical). */
export interface SocialPerson {
  user_id: string;
  display_name: string | null;
  handle: string | null;
  vitana_id: string | null;
  avatar_url: string | null;
  bio: string | null;
  city: string | null;
  country: string | null;
  /** profiles.account_visibility — 'private' profiles are name-only. */
  visibility: string | null;
}

export interface FollowEdge {
  person: SocialPerson;
  since: string;
}

export interface RelationshipSummary {
  following: FollowEdge[];
  followers: FollowEdge[];
  following_count: number;
  followers_count: number;
  /** user_ids present in both lists (mutuals). */
  mutual_ids: string[];
}

// =============================================================================
// Matches
// =============================================================================

export interface MatchSummary {
  person: SocialPerson;
  /** 0-100 score (daily_matches.match_score / user_matches.compatibility_score). */
  score: number | null;
  reasons: string[];
  source: 'daily_match' | 'user_match';
  matched_at: string | null;
  /** daily_matches.action — accepted / rejected / null etc. */
  action: string | null;
  conversation_started: boolean;
  is_current: boolean;
}

// =============================================================================
// Messages / group chats
// =============================================================================

export interface MessageContact {
  person: SocialPerson;
  last_message_at: string;
  last_direction: 'sent' | 'received';
  /** Short, consent-gated snippet of the last message (never for other users). */
  last_snippet: string | null;
  messages_30d: number;
}

export interface GroupChatSummary {
  group_id: string;
  name: string | null;
  member_count: number | null;
  is_system: boolean;
  last_message_at: string | null;
  joined_at: string | null;
}

// =============================================================================
// Posts / events (explainable ranking)
// =============================================================================

export interface RankedPost {
  post_id: string;
  author: SocialPerson;
  snippet: string;
  created_at: string;
  media_type: 'text' | 'image' | 'video';
  likes_count: number;
  comments_count: number;
  score: number;
  reason: string[];
}

export interface RankedEvent {
  event_id: string;
  title: string;
  event_type: string | null;
  start_time: string;
  location: string | null;
  url: string | null;
  participant_count: number | null;
  followed_attendees: string[];
  matched_attendees: string[];
  score: number;
  reason: string[];
}

// =============================================================================
// Person Intelligence
// =============================================================================

export interface PersonContext {
  person: SocialPerson;
  /** Viewer-relative relationship flags. */
  you_follow: boolean;
  follows_you: boolean;
  match: MatchSummary | null;
  shared_interests: string[];
  shared_groups: string[];
  shared_events: string[];
  latest_posts: Array<{ post_id: string; snippet: string; created_at: string; media_type: string }>;
  upcoming_events: Array<{ event_id: string; title: string; start_time: string }>;
  last_chat_at: string | null;
  /** True when profile is private and viewer is not connected — data minimized. */
  privacy_limited: boolean;
  recommended_next_action: string | null;
  /** One-paragraph relevance summary suitable for speech. */
  relevance_summary: string;
}

export interface ActivityItem {
  kind: 'post' | 'event_created' | 'event_joined' | 'group_joined' | 'group_post';
  at: string;
  summary: string;
  ref_id: string | null;
}

export interface ActivityContext {
  person: SocialPerson | null;
  items: ActivityItem[];
  window_days: number;
}

// =============================================================================
// The Social Context Pack (assistant-context response shape)
// =============================================================================

export interface RecommendedAction {
  action: string;
  reason: string;
  /** Optional deep-link route the frontend can navigate to. */
  route: string | null;
}

export interface SocialContextPack {
  user: SocialPerson | null;
  relationships: RelationshipSummary;
  matches: MatchSummary[];
  messages: MessageContact[];
  group_chats: GroupChatSummary[];
  interesting_posts: RankedPost[];
  interesting_events: RankedEvent[];
  /** Present only when the question referenced a specific person. */
  person_context: PersonContext | null;
  /** Present only for "what did X do recently" / "what changed" questions. */
  activity_context: ActivityContext | null;
  memory_highlights: string[];
  recommended_actions: RecommendedAction[];
  assistant_system_hints: string[];
  meta: {
    built_at: string;
    latency_ms: number;
    sections_loaded: string[];
    degraded_sections: string[];
    privacy_filters_applied: string[];
  };
}

// =============================================================================
// Intent detection
// =============================================================================

export type SocialIntentKind =
  | 'follows'
  | 'followers'
  | 'messages'
  | 'group_chats'
  | 'matches'
  | 'person_query'
  | 'person_activity'
  | 'interesting_posts'
  | 'interesting_events'
  | 'who_to_contact'
  | 'community_changes'
  | 'general_social';

export interface SocialIntentDecision {
  is_social: boolean;
  kinds: SocialIntentKind[];
  /** Candidate person name extracted from the question, if any. */
  person_hint: string | null;
}

export interface BuildSocialContextInput {
  tenant_id: string;
  user_id: string;
  /** The user's question — drives which sections are emphasized. */
  question?: string;
  surface?: 'vitana_assistant' | 'maxina_community' | 'group_chat' | 'profile' | 'feed';
  /** Explicit person target (endpoint /person/:userId). */
  person_id?: string;
  /** Compact mode caps list sizes for prompt injection. */
  compact?: boolean;
  /** Pre-computed intent (assistant path computes it once). */
  intent?: SocialIntentDecision;
}
