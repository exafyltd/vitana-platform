-- VTID-04508 (Community Autopilot CA-7): attributed invites.
-- One referral per referred member (the claim is idempotent on this index) and
-- one reusable personal invite link per member.
CREATE UNIQUE INDEX IF NOT EXISTS uq_referrals_referred_id
  ON public.referrals (referred_id) WHERE referred_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sharing_links_member_invite
  ON public.sharing_links (user_id) WHERE target_type = 'member_invite';
