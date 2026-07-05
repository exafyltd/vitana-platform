-- impact-allow-solo-migration: widens an existing CHECK constraint so
-- already-merged application code (connect-people.ts AP-0103/0106/0110,
-- community-groups.ts AP-0206/0209, all upserting edge_type='connected')
-- stops being silently rejected by Postgres. No app code change needed —
-- these call sites already write 'connected'/'suggested', they just never
-- landed.
--
-- relationship_edges_edge_type_check previously allowed only
-- ('attendee','member','host','coattendance','organizer') — all
-- event/group-context edges. 'connected' (generic person-to-person) and
-- 'suggested' (pending contact-sync suggestions, onboarding-growth.ts)
-- were missing entirely, so every "connect two people" automation shipped
-- this session has been upserting into a constraint violation, caught
-- nowhere (none of those call sites check the upsert's error), silently
-- no-op'ing since it shipped.
--
-- Applied directly to the live database (project inmkhvwdcuyhnxkgfvsb) via
-- mcp__Supabase__apply_migration during this session; this file tracks it
-- in the migration history.

ALTER TABLE relationship_edges DROP CONSTRAINT relationship_edges_edge_type_check;
ALTER TABLE relationship_edges ADD CONSTRAINT relationship_edges_edge_type_check
  CHECK (edge_type = ANY (ARRAY['attendee'::text, 'member'::text, 'host'::text, 'coattendance'::text, 'organizer'::text, 'connected'::text, 'suggested'::text]));
