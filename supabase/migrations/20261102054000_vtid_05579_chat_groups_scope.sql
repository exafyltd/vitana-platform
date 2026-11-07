-- VTID-05579 (mt-network-r2/network-groups-db) M3a, expand: chat_groups.scope / chat_group_members.scope ('community' | 'network').
--
-- Today a chat_groups row has no scope: every group is a tenant-context group (tenant_id NOT NULL). D27 adds a second kind, a
-- small invite-only group of members who may share no tenant (docs/MULTI-TENANT-PLAN.md section 4.11). The legacy migration
-- (VTID-05573) already wrote the 60 cross-tenant legacy threads into chat_groups with metadata.legacy_scope = 'network' and said
-- this lane backfills the column from that flag. This file is the EXPAND half:
--   1. ADD COLUMN scope text NOT NULL DEFAULT 'community' on both tables (a constant default: metadata only, no table rewrite)
--      with CHECK (scope IN ('community','network')).
--   2. Two CHECKs make a network group a place no system writer can target (no system fan-out, D27):
--        chat_groups_network_not_system         a network group is never is_system;
--        chat_group_members_network_no_bot      a network group never has a role = 'bot' member.
--   3. Guards (so scope is written by the RPCs of 20261102054100 only. service_role cannot write it through PostgREST or the gateway
--      client; the flag is a transaction-local setting, so a raw-SQL session of a table-writing role could set it itself: a guard
--      against mistakes and client paths, not an authentication):
--        trg_chat_groups_scope_guard   BEFORE INSERT OR UPDATE OF scope ON chat_groups: a non-community scope on INSERT, or ANY
--                                      change of an existing group's scope, needs the transaction-local flag
--                                      vitana.chat_group_rpc = 'on'. Otherwise 42501.
--        trg_chat_groups_scope_sync    AFTER UPDATE OF scope ON chat_groups: its members follow the group.
--        trg_chat_group_members_scope_guard  BEFORE INSERT OR UPDATE ON chat_group_members: the row's scope is always its group's
--                                      scope (a caller-supplied value is overwritten). A NEW member of a network group also needs
--                                      the flag (42501), is refused when it is a rule 43-45 account (service bot, notification
--                                      test actor, platform-only account: public.is_network_excluded_account, VTID-05582; 42501)
--                                      and when the group already has 20 members (54000). An INSERT of an existing member (the
--                                      idempotent legacy migration, ON CONFLICT DO NOTHING) is let through to be discarded by the
--                                      conflict. UPDATEs (read markers) only get the scope forced.
--   4. Backfill: chat_groups.scope = 'network' where metadata ->> 'legacy_scope' = 'network', and every member follows its group.
--      Every other group and member keeps the default 'community'. The backfill sets the flag itself.
-- The DEFAULT stays after this file: a writer that sends no scope (today's gateway, welcome-chat, enrollment) writes community,
-- and cannot write network (the guard). There is no contract step to wait for.
-- A group with more than 20 members that the backfill marks network stays as it is (the cap applies to new members only).
-- If the backfill meets a legacy network group that is is_system or has a bot member, a CHECK fails and the whole file rolls back.
-- Needs: is_network_excluded_account (20261102051000) and the legacy rows of 20261102052200 (otherwise nothing is classified).
-- Dark: nothing reads scope yet. Rollback: docs/validation/VTID-05579/rollback-054000-chat-groups-scope.sql.

-- impact-allow-solo-migration: adds two columns, two CHECKs and three guard triggers to the group tables; readers and writers ship in later lanes.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.chat_groups ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'community';
ALTER TABLE public.chat_group_members ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'community';

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chat_groups'::regclass AND conname = 'chat_groups_scope_check') THEN
    ALTER TABLE public.chat_groups
      ADD CONSTRAINT chat_groups_scope_check CHECK (scope IN ('community', 'network'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chat_group_members'::regclass AND conname = 'chat_group_members_scope_check') THEN
    ALTER TABLE public.chat_group_members
      ADD CONSTRAINT chat_group_members_scope_check CHECK (scope IN ('community', 'network'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chat_groups'::regclass AND conname = 'chat_groups_network_not_system') THEN
    ALTER TABLE public.chat_groups
      ADD CONSTRAINT chat_groups_network_not_system CHECK (scope = 'community' OR is_system = false);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chat_group_members'::regclass AND conname = 'chat_group_members_network_no_bot') THEN
    ALTER TABLE public.chat_group_members
      ADD CONSTRAINT chat_group_members_network_no_bot CHECK (scope = 'community' OR role <> 'bot');
  END IF;
END
$mig$;

COMMENT ON COLUMN public.chat_groups.scope IS
  'VTID-05579: community = a tenant-context group (tenant_id is the tenant); network = a small invite-only group (at most 20) whose tenant_id is only the creator''s context tenant. Written by create_network_group() only.';
COMMENT ON COLUMN public.chat_group_members.scope IS
  'VTID-05579: always the scope of the member''s group (forced by trg_chat_group_members_scope_guard).';

CREATE OR REPLACE FUNCTION public.chat_groups_scope_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.scope IS NOT DISTINCT FROM OLD.scope THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'UPDATE' OR (NEW.scope IS NOT NULL AND NEW.scope <> 'community'))
     AND coalesce(current_setting('vitana.chat_group_rpc', true), '') <> 'on' THEN
    RAISE EXCEPTION 'chat_groups.scope is written only by create_network_group()' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_groups_scope_guard() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.chat_groups_scope_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  UPDATE public.chat_group_members SET scope = NEW.scope WHERE group_id = NEW.id AND scope IS DISTINCT FROM NEW.scope;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_groups_scope_sync() FROM PUBLIC;

-- SECURITY DEFINER: the rule 43-45 helper is executable by service_role only, and the writer may be any role.
CREATE OR REPLACE FUNCTION public.chat_group_members_scope_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_scope text;
BEGIN
  SELECT g.scope INTO v_scope FROM public.chat_groups g WHERE g.id = NEW.group_id;
  IF NOT FOUND THEN
    RETURN NEW;  -- the foreign key reports it
  END IF;
  NEW.scope := v_scope;
  IF TG_OP = 'INSERT' AND v_scope = 'network' THEN
    IF EXISTS (SELECT 1 FROM public.chat_group_members m WHERE m.group_id = NEW.group_id AND m.user_id = NEW.user_id) THEN
      RETURN NEW;  -- already a member: the ON CONFLICT clause discards this row
    END IF;
    IF coalesce(current_setting('vitana.chat_group_rpc', true), '') <> 'on' THEN
      RAISE EXCEPTION 'members of a network group are added only by add_group_member()' USING ERRCODE = '42501';
    END IF;
    IF public.is_network_excluded_account(NEW.user_id) THEN
      RAISE EXCEPTION 'account_not_eligible' USING ERRCODE = '42501';
    END IF;
    IF (SELECT count(*) FROM public.chat_group_members m WHERE m.group_id = NEW.group_id) >= 20 THEN
      RAISE EXCEPTION 'group_full' USING ERRCODE = '54000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.chat_group_members_scope_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_chat_groups_scope_guard ON public.chat_groups;
CREATE TRIGGER trg_chat_groups_scope_guard
  BEFORE INSERT OR UPDATE OF scope ON public.chat_groups
  FOR EACH ROW EXECUTE FUNCTION public.chat_groups_scope_guard();

DROP TRIGGER IF EXISTS trg_chat_groups_scope_sync ON public.chat_groups;
CREATE TRIGGER trg_chat_groups_scope_sync
  AFTER UPDATE OF scope ON public.chat_groups
  FOR EACH ROW EXECUTE FUNCTION public.chat_groups_scope_sync();

DROP TRIGGER IF EXISTS trg_chat_group_members_scope_guard ON public.chat_group_members;
CREATE TRIGGER trg_chat_group_members_scope_guard
  BEFORE INSERT OR UPDATE ON public.chat_group_members
  FOR EACH ROW EXECUTE FUNCTION public.chat_group_members_scope_guard();

-- Backfill from the VTID-05573 flag. The guard needs the flag for any scope change; it is set for this statement only.
SELECT set_config('vitana.chat_group_rpc', 'on', true);
UPDATE public.chat_groups
   SET scope = 'network'
 WHERE scope = 'community' AND metadata ->> 'legacy_scope' = 'network';
SELECT set_config('vitana.chat_group_rpc', '', true);

-- The sync trigger already moved the members; this repairs any that it did not reach (it cannot differ, but a stale member
-- scope would silently break the participant rules, so it is stated).
UPDATE public.chat_group_members m
   SET scope = g.scope
  FROM public.chat_groups g
 WHERE g.id = m.group_id AND m.scope IS DISTINCT FROM g.scope;

COMMIT;
