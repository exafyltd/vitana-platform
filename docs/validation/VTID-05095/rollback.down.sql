-- VTID-05095 rollback: removes the phone verification tables, functions and
-- the un-match trigger. Verified numbers already written to auth.users stay
-- (they are the member's own confirmed number; VTID-05057's mirror keeps
-- working). Only open codes and the send log are lost.
BEGIN;
DROP TRIGGER IF EXISTS on_phone_a_withdrawn ON public.profiles;
DROP FUNCTION IF EXISTS public.unmatch_phone_contacts();
DROP FUNCTION IF EXISTS public.phone_verification_confirm(uuid, text, integer);
DROP FUNCTION IF EXISTS public.phone_verification_begin(uuid, text, text, integer, integer, integer, integer, integer);
DROP TABLE IF EXISTS public.phone_verification_sends;
DROP TABLE IF EXISTS public.phone_verification_challenges;
COMMIT;
