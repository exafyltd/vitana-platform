-- impact-allow-solo-migration: recovers schema that ALREADY-MERGED code
-- (services/gateway/src/services/d48-opportunity-surfacing-engine.ts
-- storeOpportunities/checkUserFatigue/dismissOpportunity/recordEngagement/
-- getActiveOpportunities, and now automation-handlers/connect-people.ts
-- runOpportunitySocialLayer) already calls against these exact table/column
-- names. No app code change is needed or expected.
/**
 * D48 Context-Aware Opportunity & Experience Surfacing Engine — missing table
 *
 * VTID: VTID-01142
 *
 * `contextual_opportunities` is read/written throughout
 * d48-opportunity-surfacing-engine.ts (surfaceOpportunities/storeOpportunities,
 * checkUserFatigue, filterCandidates cooldown check, dismissOpportunity,
 * recordEngagement, getActiveOpportunities) but was never defined in any
 * migration — every insert/select has been silently no-op'ing (Supabase
 * "relation does not exist" errors are caught and console.warn'd, never
 * surfaced) since the engine shipped. Discovered while wiring AP-0110
 * (Opportunity Surfacing with Social Layer), which reads this table to find
 * connections who engaged with a similar opportunity.
 *
 * Schema mirrors `ContextualOpportunityRecord` in
 * services/gateway/src/types/opportunity-surfacing.ts exactly.
 */

CREATE TABLE IF NOT EXISTS contextual_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id text,
  opportunity_type text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  confidence integer NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 100),
  why_now text NOT NULL DEFAULT '',
  relevance_factors jsonb NOT NULL DEFAULT '[]',
  suggested_action jsonb NOT NULL DEFAULT '{}',
  dismissible boolean NOT NULL DEFAULT true,
  priority_domain text NOT NULL,
  external_id text,
  external_type text,
  window_id text,
  guidance_id text,
  alignment_signal_ids jsonb DEFAULT '[]',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dismissed', 'engaged', 'expired')),
  dismissed_at timestamptz,
  dismissed_reason text,
  engaged_at timestamptz,
  engagement_type text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- checkUserFatigue: WHERE tenant_id, user_id, created_at >= today
CREATE INDEX IF NOT EXISTS idx_contextual_opportunities_tenant_user_created
  ON contextual_opportunities (tenant_id, user_id, created_at DESC);

-- cooldown check (filterCandidates): WHERE tenant_id, user_id, status='dismissed', dismissed_at >= cutoff
-- AP-0110 peer lookup: WHERE tenant_id, opportunity_type, user_id IN (...), status IN (...)
CREATE INDEX IF NOT EXISTS idx_contextual_opportunities_tenant_user_status
  ON contextual_opportunities (tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_contextual_opportunities_tenant_type_status
  ON contextual_opportunities (tenant_id, opportunity_type, status);

-- external_id lookup for cooldown Set membership
CREATE INDEX IF NOT EXISTS idx_contextual_opportunities_external_id
  ON contextual_opportunities (external_id) WHERE external_id IS NOT NULL;

ALTER TABLE contextual_opportunities ENABLE ROW LEVEL SECURITY;

-- surfaceOpportunities/dismissOpportunity/recordEngagement/getActiveOpportunities
-- run against a user-scoped client (createUserClient(authToken)) when a JWT is
-- present, so users need direct read/write on their own rows.
CREATE POLICY "Users manage own contextual opportunities"
  ON contextual_opportunities FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access on contextual_opportunities"
  ON contextual_opportunities FOR ALL
  USING (true) WITH CHECK (true);
