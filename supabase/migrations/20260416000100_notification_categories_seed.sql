-- =============================================================================
-- Seed Default Notification Categories
-- =============================================================================
-- Populates global (tenant_id = NULL) default categories across the three
-- notification types: chat, calendar, community.
-- Each category maps to existing TYPE_META keys from notification-service.ts.
-- =============================================================================

INSERT INTO notification_categories (tenant_id, type, slug, display_name, description, icon, sort_order, default_enabled, mapped_types)
VALUES
  -- ── Chat ──────────────────────────────────────────────────────────
  (NULL, 'chat', 'direct_messages', 'Direct Messages',
   'New messages from people and groups',
   'MessageSquare', 0, true,
   '["new_chat_message"]'::jsonb),

  (NULL, 'chat', 'orb_messages', 'ORB Messages',
   'Proactive messages and suggestions from your AI assistant',
   'Sparkles', 1, true,
   '["orb_proactive_message", "orb_suggestion"]'::jsonb),

  (NULL, 'chat', 'followup_reminders', 'Follow-up Reminders',
   'Reminders to continue conversations',
   'Clock', 2, true,
   '["conversation_followup_reminder"]'::jsonb),

  -- ── Calendar ──────────────────────────────────────────────────────
  (NULL, 'calendar', 'event_reminders', 'Event Reminders',
   'Upcoming events and meetups starting soon',
   'CalendarClock', 0, true,
   '["upcoming_event_today", "meetup_starting_soon", "meetup_starting_now"]'::jsonb),

  (NULL, 'calendar', 'morning_briefing', 'Morning Briefing',
   'Your daily morning summary and schedule',
   'Sun', 1, true,
   '["morning_briefing_ready"]'::jsonb),

  (NULL, 'calendar', 'weekly_digest', 'Weekly Digest',
   'Weekly community digest and activity summary',
   'Newspaper', 2, true,
   '["weekly_community_digest", "weekly_activity_summary"]'::jsonb),

  (NULL, 'calendar', 'rsvp_updates', 'RSVP Updates',
   'Confirmations and updates about your RSVPs',
   'CheckCircle', 3, true,
   '["meetup_rsvp_confirmed", "someone_rsvpd_your_meetup"]'::jsonb),

  -- ── Community ─────────────────────────────────────────────────────
  (NULL, 'community', 'group_activity', 'Group Activity',
   'Activity in your groups — joins, milestones, invitations',
   'Users', 0, true,
   '["someone_joined_your_group", "group_activity_update", "group_milestone_reached", "new_member_in_group", "group_recommended", "group_invitation_received"]'::jsonb),

  (NULL, 'community', 'meetups', 'Meetups',
   'Recommended meetups and meetup updates',
   'MapPin', 1, true,
   '["meetup_recommended", "meetup_cancelled", "new_meetup_in_group"]'::jsonb),

  (NULL, 'community', 'live_rooms', 'Live Rooms',
   'Live room starting, invites, summaries, and recordings',
   'Radio', 2, true,
   '["live_room_starting", "someone_joined_live_room", "live_room_ended_summary", "live_room_highlight_added", "live_room_invite", "live_room_recording_ready"]'::jsonb),

  (NULL, 'community', 'connections_social', 'Connections & Social',
   'New matches, connections, and social activity',
   'Heart', 3, true,
   '["new_connection_formed", "relationship_strength_increased", "new_daily_matches", "person_match_suggested", "match_accepted_by_other", "your_match_accepted", "someone_wants_to_connect", "people_near_you"]'::jsonb)

ON CONFLICT DO NOTHING;
