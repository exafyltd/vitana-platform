-- =============================================================================
-- "Alle Beisammen 🤗" — community-wide chat group everyone belongs to
-- =============================================================================
--
-- Goal: a single system chat group that EVERY registered community member is in
-- by default, and that EVERY future member auto-joins on registration — with NO
-- member cap (unlike "🎆 FIRST 100", which stays capped).
--
-- This builds on the existing VTID-03089 system-group machinery:
--   * chat_groups.is_system = true  → auto-enrollment targets
--   * fire_welcome_chat_on_membership() trigger enrolls new primary members
--   * community-group-enrollment.ts re-enrolls on login (defense in depth)
--
-- Two problems with the existing machinery had to be fixed so "everyone" works:
--   1. The 100-member cap was HARDCODED. It is now METADATA-DRIVEN
--      (chat_groups.metadata->>'cap'): NULL = uncapped, a number = capped.
--      "🎆 FIRST 100" keeps cap=100; "Alle Beisammen 🤗" is cap=NULL.
--   2. The trigger ran system-group enrollment AFTER an early RETURN for
--      tenants with >1000 members, so in a large community new users would
--      silently skip enrollment. Enrollment now runs BEFORE that early return,
--      so a primary member is ALWAYS enrolled regardless of community size.
--
-- Idempotent: safe to re-run. Group insert guarded by (tenant_id, name);
-- membership insert uses ON CONFLICT DO NOTHING; welcome message gated on
-- metadata source uniqueness.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0) Defensively pin the FIRST 100 cap in metadata.
--    The cap becomes metadata-driven below; if any FIRST 100 row lacks an
--    explicit cap, make it 100 so it can never accidentally open to everyone.
-- -----------------------------------------------------------------------------
UPDATE public.chat_groups
   SET metadata = metadata || jsonb_build_object('cap', 100)
 WHERE name = '🎆 FIRST 100'
   AND (metadata->>'cap') IS NULL;

-- -----------------------------------------------------------------------------
-- 1) Metadata-driven cap in the auto-enrollment trigger.
--    Re-creates fire_welcome_chat_on_membership() with two changes vs.
--    20260601000000_VTID_03089_welcome_chat_db_trigger.sql:
--      a) system-group enrollment moved ABOVE the recipient-count early return
--         (so it always runs, even for >1000-member tenants);
--      b) the per-group cap reads metadata->>'cap' (NULL = uncapped).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fire_welcome_chat_on_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_bot          UUID := '00000000-0000-0000-0000-000000000001';
  v_user_id      UUID := NEW.user_id;
  v_tenant_id    UUID := NEW.tenant_id;
  v_app_user     RECORD;
  v_display_name TEXT;
  v_message      TEXT;
  v_recipient    INT;
  v_inserted     INT;
BEGIN
  IF NEW.is_primary IS NOT TRUE THEN RETURN NEW; END IF;
  IF v_user_id = v_bot          THEN RETURN NEW; END IF;

  -- app_users may be inserted after user_tenants in some provisioning flows.
  -- If missing, skip silently — a follow-up insert (or backfill) will pick
  -- the user up. Better to do nothing than to send a "a new member" greeting
  -- with no name.
  SELECT user_id, display_name, COALESCE(welcome_chat_sent, false) AS welcome_chat_sent, vitana_id
    INTO v_app_user
    FROM public.app_users
   WHERE user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE NOTICE '[welcome_chat_trigger] app_users row missing for %, skipping', v_user_id;
    RETURN NEW;
  END IF;

  -- Auto-enrol in every system chat group in this tenant. The per-group cap is
  -- metadata-driven: metadata->>'cap' NULL = uncapped ("Alle Beisammen 🤗"),
  -- a number = capped ("🎆 FIRST 100" = 100). Runs FIRST, before any early
  -- return below, so every primary member is enrolled regardless of community
  -- size or whether the welcome DM fan-out has already happened. ON CONFLICT
  -- keeps re-runs safe.
  INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role)
  SELECT g.id, v_user_id, v_tenant_id, 'member'
    FROM public.chat_groups g
   WHERE g.tenant_id = v_tenant_id
     AND g.is_system = true
     AND (
       (g.metadata->>'cap') IS NULL
       OR (SELECT COUNT(*) FROM public.chat_group_members m WHERE m.group_id = g.id)
            < (g.metadata->>'cap')::int
     )
  ON CONFLICT (group_id, user_id) DO NOTHING;

  IF v_app_user.welcome_chat_sent THEN
    RETURN NEW;
  END IF;

  v_display_name := COALESCE(NULLIF(TRIM(v_app_user.display_name), ''), 'a new member');

  -- Recipient count = primary tenant members minus self minus bot.
  SELECT COUNT(*) INTO v_recipient
    FROM public.user_tenants ut
   WHERE ut.tenant_id = v_tenant_id
     AND ut.user_id <> v_user_id
     AND ut.user_id <> v_bot;

  -- 0 members or oversized community: still mark sent so we never retry.
  IF v_recipient = 0 OR v_recipient > 1000 THEN
    UPDATE public.app_users SET welcome_chat_sent = true WHERE user_id = v_user_id;
    RAISE NOTICE '[welcome_chat_trigger] tenant % has % recipients for %, marking sent without fan-out',
      v_tenant_id, v_recipient, v_user_id;
    RETURN NEW;
  END IF;

  v_message := 'Hello! My name is ' || v_display_name
            || ' — I just joined the community and I''m excited to connect with you! 🙌';

  WITH inserted AS (
    INSERT INTO public.chat_messages (
      tenant_id, sender_id, receiver_id, content, message_type, metadata,
      sender_vitana_id, receiver_vitana_id
    )
    SELECT
      v_tenant_id,
      v_user_id,
      ut.user_id,
      v_message,
      'text',
      jsonb_build_object(
        'source',     'welcome_chat',
        'automated',   true,
        'trigger',    'db_trigger_on_membership',
        'trigger_vtid','VTID-03089'
      ),
      v_app_user.vitana_id,
      (SELECT au.vitana_id FROM public.app_users au WHERE au.user_id = ut.user_id)
    FROM public.user_tenants ut
    WHERE ut.tenant_id = v_tenant_id
      AND ut.user_id <> v_user_id
      AND ut.user_id <> v_bot
    RETURNING id
  )
  SELECT COUNT(*) INTO v_inserted FROM inserted;

  UPDATE public.app_users SET welcome_chat_sent = true WHERE user_id = v_user_id;

  RAISE NOTICE '[welcome_chat_trigger] fired for % in tenant %: % messages sent, groups enrolled',
    v_user_id, v_tenant_id, v_inserted;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Never block the user_tenants insert. Surface to logs for ops.
    RAISE WARNING '[welcome_chat_trigger] FAILED for user % tenant %: % / %',
      v_user_id, v_tenant_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fire_welcome_chat_on_membership() IS
  'VTID-03089 + Alle Beisammen: enrolls new primary members in all is_system chat groups (metadata-driven cap; uncapped when metadata.cap is NULL) and sends welcome chat messages. Enrollment runs before the recipient-count early return so it is never skipped. Idempotent via app_users.welcome_chat_sent (DM fan-out only) and ON CONFLICT (enrollment).';

-- -----------------------------------------------------------------------------
-- 2) Create the "Alle Beisammen 🤗" group (idempotent), uncapped (cap = NULL).
-- -----------------------------------------------------------------------------
INSERT INTO public.chat_groups (tenant_id, name, description, is_system, metadata)
SELECT
  '2e7528b8-472a-4356-88da-0280d4639cce'::uuid,
  'Alle Beisammen 🤗',
  'Die Gruppe für alle — jedes Mitglied der Maxina Longevity Community ist automatisch dabei.',
  true,
  jsonb_build_object('seeded_by', 'alle-beisammen', 'cap', NULL)
WHERE NOT EXISTS (
  SELECT 1 FROM public.chat_groups
   WHERE tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce'::uuid
     AND name = 'Alle Beisammen 🤗'
);

-- -----------------------------------------------------------------------------
-- 3) Enrol the Vitana bot (role='bot') + EVERY primary tenant member (uncapped).
-- -----------------------------------------------------------------------------
WITH g AS (
  SELECT id, tenant_id FROM public.chat_groups
   WHERE tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce'::uuid
     AND name = 'Alle Beisammen 🤗'
),
candidates AS (
  SELECT g.id AS group_id, g.tenant_id,
         '00000000-0000-0000-0000-000000000001'::uuid AS user_id,
         'bot' AS role
  FROM g
  UNION ALL
  SELECT g.id, g.tenant_id, ut.user_id, 'member'
  FROM g
  JOIN public.user_tenants ut
    ON ut.tenant_id = g.tenant_id
   AND ut.is_primary = true
   AND ut.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
)
INSERT INTO public.chat_group_members (group_id, user_id, tenant_id, role)
SELECT group_id, user_id, tenant_id, role
FROM candidates
ON CONFLICT (group_id, user_id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4) Vitana's German welcome message (only if not already posted).
-- -----------------------------------------------------------------------------
INSERT INTO public.chat_messages
  (tenant_id, sender_id, receiver_id, group_id, content, message_type, metadata)
SELECT
  g.tenant_id,
  '00000000-0000-0000-0000-000000000001'::uuid,
  NULL,
  g.id,
  $welcome$Willkommen bei "Alle Beisammen" 🤗

Hier sind wir alle zusammen — jedes Mitglied der Maxina Longevity Community ist automatisch in dieser Gruppe dabei. Stell dich gern vor, teile, was dich bewegt, und lern die anderen kennen.

Schön, dass du da bist! 💚
Eure Vitana$welcome$,
  'text',
  jsonb_build_object(
    'source', 'vitana_group_welcome',
    'automated', true,
    'group_name', 'Alle Beisammen 🤗',
    'language', 'de',
    'seeded_by', 'alle-beisammen'
  )
FROM public.chat_groups g
WHERE g.tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce'::uuid
  AND g.name = 'Alle Beisammen 🤗'
  AND NOT EXISTS (
    SELECT 1 FROM public.chat_messages cm
    WHERE cm.group_id = g.id
      AND cm.metadata->>'source' = 'vitana_group_welcome'
  );

COMMIT;

-- Final tally for the workflow log.
SELECT
  (SELECT COUNT(*) FROM public.chat_groups WHERE name = 'Alle Beisammen 🤗') AS group_rows,
  (SELECT COUNT(*) FROM public.chat_group_members
     WHERE group_id IN (SELECT id FROM public.chat_groups WHERE name = 'Alle Beisammen 🤗')
  ) AS members_now,
  (SELECT COUNT(*) FROM public.user_tenants ut
     WHERE ut.tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce'::uuid
       AND ut.is_primary = true
  ) AS primary_members_total;
