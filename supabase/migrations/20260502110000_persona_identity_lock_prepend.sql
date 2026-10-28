-- Persona Identity Lock — prepend
--
-- Real-world testing showed personas drifting into each other's identities:
-- Vitana's voice would speak "Hi, here is Devon" mid-bridge; Devon would
-- continue Vitana's previous sentence as if it were his own. The voice
-- override IS correctly wired into the Live API setup (orb-live.ts:8283),
-- so the voice DOES change on reconnect — but the persona prompts lacked
-- a strong identity declaration. The model would absorb whoever spoke
-- last in the transcript and continue them.
--
-- This migration prepends an IDENTITY LOCK block to every persona's
-- system_prompt. Idempotent: detects the marker and skips re-prepending.
-- Each persona's snapshot is captured to agent_persona_versions before
-- the change so rollback is one click in the admin UI.

DO $$
DECLARE
  r RECORD;
  v_lock TEXT;
  v_voice_human TEXT;
BEGIN
  FOR r IN
    SELECT id, key, display_name, role, voice_id, system_prompt, version
    FROM public.agent_personas
    WHERE status <> 'archived'
  LOOP
    -- Skip if already locked.
    IF r.system_prompt LIKE '=== IDENTITY LOCK ===%' THEN
      CONTINUE;
    END IF;

    -- Voice ID is opaque to the model; surface its purpose in human terms.
    v_voice_human := CASE
      WHEN r.voice_id IS NULL OR r.voice_id = '' THEN 'your assigned language default'
      ELSE r.voice_id
    END;

    v_lock := format(
$LOCK$=== IDENTITY LOCK ===
YOU ARE %s.
Your voice is %s.
Your role is: %s.

You speak EXCLUSIVELY as %s. You NEVER:
  - introduce yourself as another persona ("Hi, this is Devon" — only Devon ever says that)
  - continue another persona's sentence as if it were your own
  - mimic another persona's tone, signature phrases, or voice
  - acknowledge another persona's words as if YOU said them
  - name yourself as anyone other than %s

The conversation transcript may show OTHER personas speaking earlier. Those
were them, not you. Read those lines as third-party context only. Your next
utterance is exclusively as %s, in %s's voice, with %s's identity.

If you ever notice yourself drifting toward another persona's identity,
stop and re-anchor: "I'm %s." Then continue.
=== END IDENTITY LOCK ===

$LOCK$,
      r.display_name,                  -- YOU ARE
      v_voice_human,                   -- Your voice is
      coalesce(r.role, 'unspecified'), -- Your role is
      r.display_name,                  -- speak EXCLUSIVELY as
      r.display_name,                  -- name yourself as anyone other than
      r.display_name,                  -- exclusively as
      r.display_name,                  -- in X's voice
      r.display_name,                  -- with X's identity
      r.display_name                   -- I'm X
    );

    -- Snapshot before mutating.
    INSERT INTO public.agent_persona_versions (persona_id, version, snapshot, change_note, created_by)
    VALUES (
      r.id,
      r.version,
      to_jsonb(r),
      'Auto-snapshot before IDENTITY LOCK prepend (forwarding v2)',
      NULL
    );

    UPDATE public.agent_personas
    SET system_prompt = v_lock || r.system_prompt,
        version = version + 1,
        updated_at = NOW()
    WHERE id = r.id;
  END LOOP;
END $$;
