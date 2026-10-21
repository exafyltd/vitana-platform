-- VTID-04872: per-member daily counter for community Class B Jev decisions
-- (owner approval 2026-10-03: 300 per member per day, safety exempt, shadow
-- first). One row per tenant x member x UTC day. Written and read by the
-- gateway's service role only; RLS on with no policies. Additive only.
-- user_id is a uuid so erase_user_data() (VTID-04765) deletes a member's rows
-- with their account.

CREATE TABLE IF NOT EXISTS public.jev_member_daily_counters (
    tenant_id UUID NOT NULL,
    user_id UUID NOT NULL,
    day DATE NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, day)
);

ALTER TABLE public.jev_member_daily_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.jev_member_daily_counters FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jev_member_daily_counters TO service_role;

-- Atomic increment; returns today's count for the member after it.
CREATE OR REPLACE FUNCTION public.jev_member_quota_bump(p_tenant_id UUID, p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
    v_day DATE := (now() AT TIME ZONE 'UTC')::date;
    v_calls INTEGER;
BEGIN
    INSERT INTO public.jev_member_daily_counters AS c (tenant_id, user_id, day, calls, updated_at)
    VALUES (p_tenant_id, p_user_id, v_day, 1, now())
    ON CONFLICT (tenant_id, user_id, day) DO UPDATE
       SET calls = c.calls + 1, updated_at = now()
    RETURNING c.calls INTO v_calls;
    RETURN v_calls;
END;
$fn$;
REVOKE ALL ON FUNCTION public.jev_member_quota_bump(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.jev_member_quota_bump(UUID, UUID) TO service_role;

COMMENT ON TABLE public.jev_member_daily_counters IS
  'VTID-04872: Class B community Jev calls per member per UTC day (quota 300, JEV_MEMBER_QUOTA_MODE shadow|enforce). Rows older than 7 days carry no meaning and may be deleted.';
