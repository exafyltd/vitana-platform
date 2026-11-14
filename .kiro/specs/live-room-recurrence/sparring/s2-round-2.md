# Sparring round 2 — in_progress

Session: `1e9e89c5-00cb-4229-9e27-4c64ae409feb` · plan hash `f154a5dabe9ad33d5570ab65613534ea859ceb8ab8d0b9af6ded81706c49baf7`

## Summary

Round 2 review. All three R1 findings were accepted and the revised plan addresses them textually: `session_defaults` and `co_host_user_ids` added to the series table (R1-F1), `FOR UPDATE` serialisation added to `live_room_series_promote_next` (R1-F2), and the tighter rrule CHECK without BYDAY (R1-F3). I verified these are present in the revised plan text.

One new major finding: occurrence 0, created through the existing `live_room_create_session` path (which the plan declares "unchanged"), will lack `series_id` and `series_index` because that SQL function's INSERT column list does not include them. This means occurrence 0 is invisible to every series-scoped operation (edit, cancel, promotion queries).

## Findings

### R2-F1 [major]

Occurrence 0 will not have `series_id` or `series_index` set. The plan says occurrence 0 is created through the existing `live_room_create_session` path (and lists that function under 'Unchanged'), but this function's INSERT at lines 352-371 uses a fixed column list that does not include `series_id` or `series_index`. The new columns (added by the series migration) will default to NULL. This means: (1) `scope: "series"` edits that query `WHERE series_id = <id>` will miss occurrence 0; (2) cancel-series that sets cancelled `WHERE series_id = <id> AND status = 'scheduled'` will miss occurrence 0; (3) the unique index on `(series_id, series_index)` won't cover occurrence 0 (NULLs are distinct in PG unique indexes); (4) promotion queries that look for the next scheduled occurrence by `series_id` would also miss occurrence 0 (though it's already linked as `current_session_id` at that point, so this is less impactful). Occurrence 0 effectively looks like a standalone session despite being part of the series.

- `exafyltd/vitana-platform:supabase/migrations/20260210100000_vtid_01228_live_room_session_mgmt.sql:351` —     -- Create session
    INSERT INTO public.live_room_sessions (
      tenant_id, room_id, session_title, topic_keys, status,
      access_level, starts_at, ends_at, auto_admit,
      lobby_buffer_minutes, max_participants, metadata, idempotency_key
    ) VALUES (
      v_room.tenant_id,
      p_room_id,
      p_payload->>'session_title',
      COALESCE((SELECT array_agg(elem::TEXT) FROM jsonb_array_elements_text(p_payload->'topic_keys') AS elem), '{}'),
      v_initial_status,
      COALESCE(p_payload->>'access_level', 'public'),
      v_starts_at,
      (p_payload->>'ends_at')::TIMESTAMPTZ,
      v_auto_admit,
      COALESCE((p_payload->>'lobby_buffer_minutes')::INT, 15),
      COALESCE((p_payload->>'max_participants')::INT, 100),
      COALESCE(p_payload->'metadata', '{}'::JSONB),
      v_idempotency_key
    )
    RETURNING id INTO v_session_id;

Suggestion: Either (a) use `live_room_series_insert_occurrence` for occurrence 0 as well (and have the gateway separately link it to the room via an UPDATE on `live_rooms.current_session_id` and room status), or (b) after creating occurrence 0 with `live_room_create_session`, have the gateway issue a service_role UPDATE to set `series_id` and `series_index = 0` on the returned session row, or (c) accept that `live_room_create_session` is not truly unchanged and add `series_id` and `series_index` to its INSERT column list (reading them from `p_payload`). Option (a) is cleanest since it keeps `live_room_create_session` unchanged and guarantees all occurrences are created through the same path, but requires separating session creation from room linking. Whichever option is chosen, spell it out in the plan and add a test that a `scope: "series"` edit and a cancel-series both include occurrence 0.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
