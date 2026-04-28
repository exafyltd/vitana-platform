-- Dance specialized market — D7 Open Asks (VTID-DANCE-D7)
-- A read-only view that surfaces every public open intent with no matches
-- yet. The "always post even if there's no match" UX principle made
-- concrete: the user's post is publicly browsable so other community
-- members can find it organically.

CREATE OR REPLACE VIEW public.intent_open_asks AS
SELECT
  ui.intent_id,
  ui.requester_user_id,
  ui.requester_vitana_id,
  ui.tenant_id,
  ui.intent_kind,
  ui.category,
  ui.title,
  ui.scope,
  ui.kind_payload,
  ui.match_count,
  ui.created_at,
  ui.expires_at
FROM public.user_intents ui
WHERE ui.status = 'open'
  AND ui.visibility = 'public'
  AND ui.match_count = 0
  AND (ui.expires_at IS NULL OR ui.expires_at > now());

COMMENT ON VIEW public.intent_open_asks IS
  'D7: public feed of intent posts that have no matches yet. Drives the "you are not invisible" cold-start primer — visible to all authenticated members on /community/open-asks.';
