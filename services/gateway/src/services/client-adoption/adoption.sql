-- VTID-05658 — native adoption facts per active member (READ-ONLY: one SELECT, no writes).
-- $1 = window start (date, inclusive), $2 = window end (date, exclusive).
-- One row per (tenant, member) seen in the window. `appilix` = an un-revoked user_device_tokens row
-- labelled 'Appilix %'. adoption.ts turns these facts into aggregate counts; only aggregates leave.
SELECT
  s.tenant_id,
  s.user_id,
  bool_or(s.client_class = 'native') AS has_native,
  bool_or(s.client_class = 'web')    AS has_web,
  EXISTS (
    SELECT 1
      FROM user_device_tokens t
     WHERE t.user_id = s.user_id
       AND t.revoked_at IS NULL
       AND t.device_label LIKE 'Appilix %'
  ) AS has_appilix
FROM client_identity_daily_seen s
WHERE s.day >= $1::date
  AND s.day <  $2::date
GROUP BY s.tenant_id, s.user_id;
