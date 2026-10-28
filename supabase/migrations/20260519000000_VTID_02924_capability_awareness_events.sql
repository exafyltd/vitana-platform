-- B0e.4 (orb-live-refactor) — capability_awareness_events log + advance RPC.
--
-- VTID-02924. The audit log + idempotency boundary for awareness-state
-- mutations. Pairs with user_capability_awareness (B0e.1) which holds
-- the latest state per (tenant, user, capability_key).
--
-- Wall discipline (locked by user):
--   - Selection (B0e.2) is read-only.
--   - Preview routes (B0e.3) are read-only.
--   - State advancement happens ONLY through this table + the
--     accompanying RPC. The provider/preview paths NEVER touch it.
--
-- Idempotency:
--   UNIQUE (tenant_id, user_id, idempotency_key) — the same event with
--   the same key is recorded ONCE; subsequent calls return the
--   existing row without re-advancing the awareness ladder.
--
-- Allowed transitions (state machine; the RPC enforces these):
--   unknown    → introduced | seen | tried | completed | dismissed
--                  (entry from any signal can land at any non-terminal
--                   non-mastered state)
--   introduced → seen | tried | completed | dismissed
--   seen       → tried | completed | dismissed
--   tried      → completed | dismissed
--   completed  → mastered | dismissed
--   dismissed  → introduced       (explicit reopen — the ONLY way out)
--   mastered   → (terminal; no transitions out)
--
-- Source linkage:
--   decision_id ties the event back to an AssistantContinuationDecision
--   (B0d.1) when available. The Command Hub Continuation Inspector can
--   trace user actions back to the originating decision.

-- ---------------------------------------------------------------
-- capability_awareness_events — audit log
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS capability_awareness_events (
  event_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  user_id           UUID NOT NULL,
  capability_key    TEXT NOT NULL REFERENCES system_capabilities(capability_key),
  event_name        TEXT NOT NULL CHECK (event_name IN (
                      'introduced','seen','tried','completed','dismissed','mastered'
                    )),
  previous_state    TEXT NOT NULL CHECK (previous_state IN (
                      'unknown','introduced','seen','tried','completed','dismissed','mastered'
                    )),
  next_state        TEXT NOT NULL CHECK (next_state IN (
                      'unknown','introduced','seen','tried','completed','dismissed','mastered'
                    )),
  decision_id       TEXT,                                  -- AssistantContinuationDecision.decisionId
  idempotency_key   TEXT NOT NULL,
  source_surface    TEXT,                                  -- orb_wake | orb_turn_end | text_turn_end | home
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotency boundary: the same key + tenant + user can only land once.
  UNIQUE (tenant_id, user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS capability_awareness_events_user_idx
  ON capability_awareness_events (tenant_id, user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS capability_awareness_events_capability_idx
  ON capability_awareness_events (tenant_id, user_id, capability_key, occurred_at DESC);

CREATE INDEX IF NOT EXISTS capability_awareness_events_decision_idx
  ON capability_awareness_events (decision_id)
  WHERE decision_id IS NOT NULL;

ALTER TABLE capability_awareness_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS capability_awareness_events_tenant_isolation ON capability_awareness_events;
CREATE POLICY capability_awareness_events_tenant_isolation
  ON capability_awareness_events
  FOR ALL
  TO authenticated
  USING (
    tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM user_tenants WHERE user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------
-- advance_capability_awareness() — the ONLY mutation entrypoint
--
-- Atomic: validates the transition, writes the event log row (with
-- ON CONFLICT for idempotency), then upserts user_capability_awareness.
-- Returns a JSON envelope describing the outcome.
--
-- Outcomes:
--   { ok: true, idempotent: false, previous_state, next_state, event_id }
--   { ok: true, idempotent: true,  previous_state, next_state, event_id }
--   { ok: false, reason: 'transition_not_allowed', previous_state, attempted_event }
--   { ok: false, reason: 'unknown_capability', ... }
-- ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION advance_capability_awareness(
  p_tenant_id        UUID,
  p_user_id          UUID,
  p_capability_key   TEXT,
  p_event_name       TEXT,
  p_idempotency_key  TEXT,
  p_decision_id      TEXT DEFAULT NULL,
  p_source_surface   TEXT DEFAULT NULL,
  p_occurred_at      TIMESTAMPTZ DEFAULT NULL,
  p_metadata         JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_capability_exists BOOLEAN;
  v_previous_state    TEXT;
  v_next_state        TEXT;
  v_event_id          UUID;
  v_existing_event    capability_awareness_events%ROWTYPE;
  v_now               TIMESTAMPTZ := COALESCE(p_occurred_at, now());
BEGIN
  -- Validate capability exists (FK gives this too, but we want a
  -- specific reason string).
  SELECT EXISTS(SELECT 1 FROM system_capabilities WHERE capability_key = p_capability_key)
    INTO v_capability_exists;
  IF NOT v_capability_exists THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_capability');
  END IF;

  -- Idempotency short-circuit: if the event already exists, return
  -- the recorded outcome WITHOUT re-applying the transition.
  SELECT * INTO v_existing_event
    FROM capability_awareness_events
   WHERE tenant_id = p_tenant_id
     AND user_id = p_user_id
     AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'previous_state', v_existing_event.previous_state,
      'next_state', v_existing_event.next_state,
      'event_id', v_existing_event.event_id
    );
  END IF;

  -- Read current state (default 'unknown' if no row yet).
  SELECT awareness_state INTO v_previous_state
    FROM user_capability_awareness
   WHERE tenant_id = p_tenant_id
     AND user_id = p_user_id
     AND capability_key = p_capability_key;
  IF v_previous_state IS NULL THEN
    v_previous_state := 'unknown';
  END IF;

  -- State machine: compute the next state.
  v_next_state := NULL;
  IF v_previous_state = 'unknown' THEN
    IF p_event_name IN ('introduced','seen','tried','completed','dismissed') THEN
      v_next_state := p_event_name;
    END IF;
  ELSIF v_previous_state = 'introduced' THEN
    IF p_event_name IN ('seen','tried','completed','dismissed') THEN
      v_next_state := p_event_name;
    END IF;
  ELSIF v_previous_state = 'seen' THEN
    IF p_event_name IN ('tried','completed','dismissed') THEN
      v_next_state := p_event_name;
    END IF;
  ELSIF v_previous_state = 'tried' THEN
    IF p_event_name IN ('completed','dismissed') THEN
      v_next_state := p_event_name;
    END IF;
  ELSIF v_previous_state = 'completed' THEN
    IF p_event_name IN ('mastered','dismissed') THEN
      v_next_state := p_event_name;
    END IF;
  ELSIF v_previous_state = 'dismissed' THEN
    -- Explicit reopen — the ONLY way out of dismissed.
    IF p_event_name = 'introduced' THEN
      v_next_state := 'introduced';
    END IF;
  ELSIF v_previous_state = 'mastered' THEN
    -- Terminal — no transitions out in this slice.
    v_next_state := NULL;
  END IF;

  IF v_next_state IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'transition_not_allowed',
      'previous_state', v_previous_state,
      'attempted_event', p_event_name
    );
  END IF;

  -- Write the audit log row. The UNIQUE constraint on
  -- (tenant_id, user_id, idempotency_key) means a race produces a
  -- duplicate-key error — we catch and recover with the SELECT path.
  BEGIN
    INSERT INTO capability_awareness_events (
      tenant_id, user_id, capability_key, event_name,
      previous_state, next_state, decision_id, idempotency_key,
      source_surface, occurred_at, metadata
    ) VALUES (
      p_tenant_id, p_user_id, p_capability_key, p_event_name,
      v_previous_state, v_next_state, p_decision_id, p_idempotency_key,
      p_source_surface, v_now, p_metadata
    )
    RETURNING event_id INTO v_event_id;
  EXCEPTION WHEN unique_violation THEN
    -- Race lost the idempotency check above; replay the winner.
    SELECT * INTO v_existing_event
      FROM capability_awareness_events
     WHERE tenant_id = p_tenant_id
       AND user_id = p_user_id
       AND idempotency_key = p_idempotency_key;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'previous_state', v_existing_event.previous_state,
      'next_state', v_existing_event.next_state,
      'event_id', v_existing_event.event_id
    );
  END;

  -- Upsert the latest-state row.
  INSERT INTO user_capability_awareness (
    tenant_id, user_id, capability_key, awareness_state,
    first_introduced_at, last_introduced_at,
    first_used_at, last_used_at,
    use_count, dismiss_count, last_surface,
    created_at, updated_at
  ) VALUES (
    p_tenant_id, p_user_id, p_capability_key, v_next_state,
    CASE WHEN p_event_name = 'introduced' THEN v_now END,
    CASE WHEN p_event_name = 'introduced' THEN v_now END,
    CASE WHEN p_event_name IN ('tried','completed','mastered') THEN v_now END,
    CASE WHEN p_event_name IN ('tried','completed','mastered') THEN v_now END,
    CASE WHEN p_event_name IN ('tried','completed','mastered') THEN 1 ELSE 0 END,
    CASE WHEN p_event_name = 'dismissed' THEN 1 ELSE 0 END,
    p_source_surface,
    now(), now()
  )
  ON CONFLICT (tenant_id, user_id, capability_key) DO UPDATE SET
    awareness_state = EXCLUDED.awareness_state,
    last_introduced_at = CASE
      WHEN p_event_name = 'introduced' THEN v_now
      ELSE user_capability_awareness.last_introduced_at
    END,
    first_introduced_at = COALESCE(
      user_capability_awareness.first_introduced_at,
      CASE WHEN p_event_name = 'introduced' THEN v_now END
    ),
    last_used_at = CASE
      WHEN p_event_name IN ('tried','completed','mastered') THEN v_now
      ELSE user_capability_awareness.last_used_at
    END,
    first_used_at = COALESCE(
      user_capability_awareness.first_used_at,
      CASE WHEN p_event_name IN ('tried','completed','mastered') THEN v_now END
    ),
    use_count = user_capability_awareness.use_count
      + CASE WHEN p_event_name IN ('tried','completed','mastered') THEN 1 ELSE 0 END,
    dismiss_count = user_capability_awareness.dismiss_count
      + CASE WHEN p_event_name = 'dismissed' THEN 1 ELSE 0 END,
    last_surface = COALESCE(p_source_surface, user_capability_awareness.last_surface),
    updated_at = now();

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'previous_state', v_previous_state,
    'next_state', v_next_state,
    'event_id', v_event_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION advance_capability_awareness TO authenticated, service_role;

COMMENT ON TABLE capability_awareness_events IS
  'B0e.4 (orb-live-refactor): audit log + idempotency boundary for awareness-state '
  'mutations. The advance_capability_awareness() RPC is the ONLY mutation '
  'entrypoint — provider/preview paths NEVER touch this table.';

COMMENT ON FUNCTION advance_capability_awareness IS
  'B0e.4: atomic awareness state advancement. Validates transition against the '
  '7-state ladder, idempotent on (tenant_id, user_id, idempotency_key), '
  'logs every event to capability_awareness_events, upserts '
  'user_capability_awareness with new state + timestamps. Selection '
  '(B0e.2) and preview (B0e.3) NEVER call this.';
