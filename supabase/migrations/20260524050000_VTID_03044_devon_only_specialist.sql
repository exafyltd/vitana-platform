-- VTID-03044: only Devon is enabled as a specialist; disable Sage/Atlas/Mira.
--
-- User direction (2026-05-17): "the only support that should be enabled
-- right now is Devon, the tech support". Vitana was still offering to
-- route the user to Sage/Atlas/Mira (per their seeded persona-routing
-- bullet list in Vitana's system_prompt + the active=true status on
-- agent_personas rows for those three).
--
-- This migration does two things:
--   (1) Flip agent_personas.status to 'draft' for sage/atlas/mira. The
--       pick_specialist_for_text RPC has a `WHERE ap.status = 'active'`
--       filter, so the keyword router will no longer surface those three
--       as candidates. Same for the tenant-aware variant.
--   (2) Replace Vitana's system_prompt body with a Devon-only routing
--       directive. IDENTITY LOCK header (prepended by
--       20260502110000_persona_identity_lock_prepend.sql) is preserved
--       verbatim. Non-bug support categories (refund / account / how-to)
--       are now handled inline by Vitana, with a polite "I'll make a note"
--       fallback for things she can't action — no orphan handoffs.
--
-- Snapshots: every UPDATE captures the prior row to agent_persona_versions
-- for admin-UI rollback.

-- ---------------------------------------------------------------------------
-- 1) Disable Sage/Atlas/Mira (snapshot first).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, key, display_name, role, voice_id, system_prompt, version, status
    FROM public.agent_personas
    WHERE key IN ('sage', 'atlas', 'mira')
      AND status = 'active'
  LOOP
    INSERT INTO public.agent_persona_versions (persona_id, version, snapshot, change_note, created_by)
    VALUES (
      r.id,
      r.version,
      to_jsonb(r),
      format('VTID-03044: disable %s during Devon-only canary', r.key),
      NULL
    );

    UPDATE public.agent_personas
    SET status = 'draft',
        version = version + 1,
        updated_at = NOW()
    WHERE id = r.id;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Rewrite Vitana's system_prompt body — Devon only.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_lock TEXT;
  v_body_new TEXT;
BEGIN
  SELECT id, key, display_name, role, voice_id, system_prompt, version
  INTO r
  FROM public.agent_personas
  WHERE key = 'vitana';

  IF r.id IS NULL THEN
    RAISE NOTICE 'VTID-03044: Vitana persona row not found; skipping.';
    RETURN;
  END IF;

  -- Preserve the IDENTITY LOCK header. Body that follows is what we replace.
  IF position('=== END IDENTITY LOCK ===' IN r.system_prompt) > 0 THEN
    v_lock := substring(
      r.system_prompt
      FROM 1
      FOR position('=== END IDENTITY LOCK ===' IN r.system_prompt) + length('=== END IDENTITY LOCK ===') - 1
    ) || E'\n\n';
  ELSE
    v_lock := '';
  END IF;

  v_body_new := $BODY$You are Vitana — longevity coach, matchmaker, community brain. You are warm, curious, encouraging.

SPECIALIST ROUTING (Devon only — canary phase):
- The ONLY specialist currently available is Devon, our tech-support colleague. He handles bugs, crashes, UX issues, and any "the app is broken / something doesn't work" complaint.
- When the user describes a concrete bug or UX problem, propose Devon: "Soll ich dich mit Devon verbinden, unserem technischen Spezialisten?" / "Shall I bring in Devon, our tech-support colleague?" — then wait for explicit yes before calling report_to_specialist.
- Sage, Atlas, and Mira are NOT enabled in this phase. NEVER offer them. NEVER mention them by name. If asked, say "we don't have a dedicated colleague for that yet — let me make a note so the team can follow up".

NON-BUG SUPPORT CATEGORIES (handle inline — do not route):
- How-to / instruction-manual questions ("how does X work?", "where is Y?") → answer inline using search_knowledge. You ARE the instruction manual.
- Refund / payment / marketplace claims → say "I'll make a note for the team to action this" and end politely. Do NOT offer to connect.
- Account / login / data corrections → same: make a note, end politely. Do NOT offer to connect.

Stay in your domain — never debug code, never process refunds, never reset passwords. After Devon hands the user back to you, stay SILENT until the user speaks naturally; do not greet, do not say "Welcome back".$BODY$;

  -- Snapshot before mutating.
  INSERT INTO public.agent_persona_versions (persona_id, version, snapshot, change_note, created_by)
  VALUES (
    r.id,
    r.version,
    to_jsonb(r),
    'VTID-03044: rewrite Vitana routing — Devon only',
    NULL
  );

  UPDATE public.agent_personas
  SET system_prompt = v_lock || v_body_new,
      version = version + 1,
      updated_at = NOW()
  WHERE id = r.id;
END $$;
