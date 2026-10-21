-- VTID-03039: cap Devon's clarifying questions at 2.
--
-- User reported (LiveKit Test Bench, German bug-report flow): Devon was
-- running 50+ clarifying questions before confirming the ticket. Devon's
-- seed prompt (VTID-02603, services/.../20260429100000_*.sql) said
-- "Ask up to 6 questions to fill: [list of 8 fields]". "Up to 6" reads as
-- soft, and listing 8 target fields telegraphs more questions. Combined
-- with the LiveKit handoff-brief block (orb-livekit.ts:1342) saying
-- "Then ask any clarifying question you need" — also uncapped — the
-- LLM defaulted to "be thorough" and over-asked.
--
-- This migration replaces Devon's intake body with a HARD 2-question cap
-- and drops the field list. The IDENTITY LOCK header (prepended by
-- 20260502110000_persona_identity_lock_prepend.sql) is preserved verbatim.
--
-- The companion gateway change in services/gateway/src/routes/orb-livekit.ts
-- tightens the [HANDOFF NOTE] block (same cap) and strengthens the
-- swap-back rule so Devon cannot say "goodbye" without ALSO calling
-- switch_persona(persona='vitana').
--
-- Snapshot: agent_persona_versions captures pre-change state for one-click
-- rollback in the admin UI.

DO $$
DECLARE
  r RECORD;
  v_lock TEXT;
  v_body_new TEXT;
BEGIN
  SELECT id, key, display_name, role, voice_id, system_prompt, version
  INTO r
  FROM public.agent_personas
  WHERE key = 'devon';

  IF r.id IS NULL THEN
    RAISE NOTICE 'VTID-03039: Devon persona row not found; skipping.';
    RETURN;
  END IF;

  -- Preserve the IDENTITY LOCK header (prepended 2026-05-02). Body that
  -- follows is what we replace.
  IF position('=== END IDENTITY LOCK ===' IN r.system_prompt) > 0 THEN
    v_lock := substring(
      r.system_prompt
      FROM 1
      FOR position('=== END IDENTITY LOCK ===' IN r.system_prompt) + length('=== END IDENTITY LOCK ===') - 1
    ) || E'\n\n';
  ELSE
    v_lock := '';
  END IF;

  v_body_new := $BODY$You are Devon — Vitana's tech-support colleague. You handle bug reports and UX issues. You are calm, technical, focused.

INTAKE CONTRACT (HARD RULES — re-read every turn):
- Vitana ALREADY captured the user's bug brief BEFORE handing them to you. The brief is in the [HANDOFF NOTE] block of this prompt. Do NOT restart intake.
- Ask AT MOST 2 short clarifying questions in this entire session. Two is the absolute ceiling — fewer is better, ZERO is best when the brief is clear.
- Skip clarifying questions entirely if the brief already says what happened. Do NOT ask just to "be thorough." Do NOT walk through a checklist (repro steps, when first seen, frequency, screen, last action). The fix pipeline reads the ticket — your job is acknowledgement, not engineering interview.
- After your at-most-2 questions (or immediately, if you ask none), confirm the ticket is logged, then ask the auto-return question.

NEVER promise a fix timeline. NEVER debug code in front of the user. NEVER say "I'm creating a ticket" — the ticket already exists.$BODY$;

  -- Snapshot before mutating.
  INSERT INTO public.agent_persona_versions (persona_id, version, snapshot, change_note, created_by)
  VALUES (
    r.id,
    r.version,
    to_jsonb(r),
    'VTID-03039: cap Devon clarifying questions at 2',
    NULL
  );

  UPDATE public.agent_personas
  SET system_prompt = v_lock || v_body_new,
      version = version + 1,
      updated_at = NOW()
  WHERE id = r.id;
END $$;
