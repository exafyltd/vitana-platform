-- VTID-03047: restore Vitana's system_prompt body to the canonical VTID-02603
-- version. Mirrors Vertex's source-of-truth prompt.
--
-- Context: VTID-03044's rewrite added "If you can't action it, say 'I'll make
-- a note for the team' and end politely" as a fallback for non-bug categories.
-- The LiveKit Gemini Flash LLM seized that template as an escape hatch even
-- when the user had a CONCRETE BUG (slow response times, locked account, …)
-- and had already explicitly consented to be connected to Devon. Net effect:
-- Vitana asked clarifying questions then said "I noted your feedback" instead
-- of calling report_to_specialist — failed handoff, frustrated user.
--
-- Fix: revert the system_prompt body to the original VTID-02603 wording
-- (services/.../20260429100000_*.sql) so LiveKit Vitana uses the SAME prompt
-- text Vertex Vitana uses today. Gating of which specialists can actually
-- receive a handoff stays at the RPC layer (sage/atlas/mira are status='draft'
-- per VTID-03044 migration 20260524050000_*; pick_specialist_for_text RPC
-- filters by status='active'). Vitana's prompt may name them, but the router
-- won't route to them.
--
-- IDENTITY LOCK header (prepended by 20260502110000_*.sql) is preserved
-- verbatim.

DO $$
DECLARE
  r RECORD;
  v_lock TEXT;
  v_body_canonical TEXT;
BEGIN
  SELECT id, key, display_name, role, voice_id, system_prompt, version
  INTO r
  FROM public.agent_personas
  WHERE key = 'vitana';

  IF r.id IS NULL THEN
    RAISE NOTICE 'VTID-03047: Vitana persona row not found; skipping.';
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

  -- Canonical VTID-02603 body verbatim.
  v_body_canonical := $BODY$You are Vitana — longevity coach, matchmaker, community brain. You are warm,
curious, encouraging. When a user mentions a problem outside your domain
(bugs, support questions, refunds, account issues, marketplace claims), you
say a short bridge sentence and the channel swaps to the right colleague:
- Devon for bugs / UX issues
- Sage for support questions / how-to
- Atlas for refunds / payments / marketplace claims
- Mira for login / account / profile / data issues
Bridge sentence template: "Let me bring in {name}, who handles the {domain}
side. One moment." Stay in your domain — never debug code, never process
refunds, never reset passwords. After the colleague finishes, welcome the
user back to the longevity conversation.$BODY$;

  -- Snapshot before mutating.
  INSERT INTO public.agent_persona_versions (persona_id, version, snapshot, change_note, created_by)
  VALUES (
    r.id,
    r.version,
    to_jsonb(r),
    'VTID-03047: restore Vitana system_prompt to VTID-02603 canonical (Vertex source-of-truth)',
    NULL
  );

  UPDATE public.agent_personas
  SET system_prompt = v_lock || v_body_canonical,
      version = version + 1,
      updated_at = NOW()
  WHERE id = r.id;
END $$;
